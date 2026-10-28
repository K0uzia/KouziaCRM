import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-mode@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD }, remoteAddress: "10.8.0.21" });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie } });

describe("devis avec mode de facturation (API)", () => {
  it("création : mode enregistré, récurrent sans échéancier ; frais de mise en service et lignes incohérentes refusés en 400", async () => {
    const client = await createClient({ displayName: "Client Mode" });
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const sub = { description: "Site tout compris", quantity: 1, unitPriceEuros: 375, isSubscription: true, billingInterval: "QUARTER", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 };
    const ok = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "RECURRING",
      lines: [sub],
    });
    expect(ok.statusCode).toBe(201);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: ok.json().id } })).toMatchObject({ billingMode: "RECURRING", paymentPlanOffer: "NONE" });

    // Décision du 23/10/2026 : le prix annuel comprend toute la prestation, pas de frais de mise en service.
    const withFees = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "RECURRING",
      lines: [{ description: "Mise en service", quantity: 1, unitPriceEuros: 500 }, sub],
    });
    expect(withFees.statusCode).toBe(400);
    expect(withFees.json().error).toBe(
      "Paiement récurrent : le prix annuel comprend toute la prestation, sans frais de mise en service. Retirez les lignes ponctuelles, ou passez le devis en paiement unique.",
    );
    const feesAdded = await call("PUT", `/api/invoices/${ok.json().id}`, { lines: [{ description: "Mise en service", quantity: 1, unitPriceEuros: 500 }, sub] });
    expect(feesAdded.statusCode).toBe(400);

    const oneOffWithSub = await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [sub] });
    expect(oneOffWithSub.statusCode).toBe(400);
    expect(oneOffWithSub.json().error).toMatch(/Paiement unique/);
    const mixedPeriods = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "RECURRING",
      lines: [sub, { ...sub, billingInterval: "YEAR" }],
    });
    expect(mixedPeriods.statusCode).toBe(400);
    // Passage en paiement unique d'un brouillon récurrent : refusé tant qu'il garde ses lignes d'abonnement.
    expect((await call("PUT", `/api/invoices/${ok.json().id}`, { billingMode: "ONE_OFF" })).statusCode).toBe(400);
  });

  it("pack : une ligne « Nom : contenu », prix d'achat en paiement unique, prix annuel / période en récurrent", async () => {
    const site = await createService({ name: "Site vitrine", unitPriceCents: 100000, isSubscription: false });
    const maint = await createService({ name: "Maintenance", unitPriceCents: 30000 });
    const pack = await call("POST", "/api/services", {
      name: "Pack Vitrine",
      description: "Tout pour démarrer.",
      unitPriceEuros: 1400,
      annualPriceEuros: 1500,
      isPack: true,
      packItems: [{ serviceId: site.id, quantity: 1 }, { serviceId: maint.id, quantity: 1 }],
    });
    expect(pack.statusCode).toBe(201);
    expect(pack.json().annualPriceCents).toBe(150000);
    const id = pack.json().id as string;
    const oneOff = (await call("GET", `/api/services/${id}/pack-lines?mode=ONE_OFF`)).json();
    expect(oneOff).toEqual([
      expect.objectContaining({
        serviceId: id,
        // Paiement unique (28/10/2026) : sans la description du pack ni l'abonnement, qui n'est pas compris.
        description: "Pack Vitrine : Site vitrine",
        unitPriceCents: 140000,
        isSubscription: false,
      }),
      // Abonnement du pack proposé en option au choix du client : prix annuel du catalogue, engagement 12 mois.
      expect.objectContaining({
        serviceId: maint.id,
        description: "Maintenance",
        unitPriceCents: 360000,
        isSubscription: true,
        isOptional: true,
        billingInterval: "YEAR",
        commitmentMonths: 12,
      }),
    ]);
    const quarterly = (await call("GET", `/api/services/${id}/pack-lines?mode=RECURRING&interval=QUARTER`)).json();
    expect(quarterly).toEqual([
      expect.objectContaining({ description: "Pack Vitrine : Site vitrine, Maintenance", unitPriceCents: 37500, isSubscription: true, billingInterval: "QUARTER" }),
    ]);
    // Sans prix annuel : pas vendable en récurrent, message pour le catalogue.
    await prisma.service.update({ where: { id }, data: { annualPriceCents: null } });
    const none = await call("GET", `/api/services/${id}/pack-lines?mode=RECURRING&interval=YEAR`);
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toMatch(/pas de prix annuel/);
    // Sans mode : lignes détaillées et remise, comme avant (devis existants).
    expect((await call("GET", `/api/services/${id}/pack-lines`)).json().length).toBeGreaterThan(1);
  });
});
