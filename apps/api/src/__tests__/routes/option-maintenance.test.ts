import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { writeSiteText } from "@/lib/site/texts.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Devis en paiement unique avec maintenance en option, compris et non compris (décisions du 28/10/2026).
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-option-maintenance@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

const OFFRES = {
  formules: {
    site: { titre: "Site tout compris", items: ["Création du site", "Hébergement et nom de domaine", "Mises à jour et sauvegardes"] },
    logiciel: { titre: "Logiciel", items: ["Maintenance du logiciel"] },
  },
  tarif: "Sur devis",
};

async function maintenanceService() {
  return createService({ name: "Maintenance annuelle", unitPriceCents: 30000 });
}

const site = { description: "Création du site vitrine", quantity: 1, unitPriceEuros: 1200 };
const optionLine = (serviceId: string, extra: Record<string, unknown> = {}) => ({
  description: "Maintenance annuelle",
  quantity: 1,
  unitPriceEuros: 300,
  isSubscription: true,
  isOptional: true,
  billingInterval: "YEAR",
  billingDay: 1,
  serviceId,
  commitmentMonths: 24,
  ...extra,
});

export async function oneOffQuoteWithOption(opts: { issue?: boolean; offer?: string } = {}) {
  const client = await createClient({ displayName: "Client Option Maintenance" });
  const svc = await maintenanceService();
  const res = await call("POST", "/api/invoices", {
    clientId: client.id,
    documentType: "QUOTE",
    billingMode: "ONE_OFF",
    paymentPlanOffer: opts.offer ?? "TWO",
    lines: [site, optionLine(svc.id)],
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  if (opts.issue !== false) {
    const issued = await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } });
    expect(issued.statusCode, issued.body).toBe(200);
  }
  return { id, clientId: client.id, serviceId: svc.id };
}

describe("ligne en option : règles et totaux", () => {
  it("paiement unique : option hors du total enregistré, départ à la livraison, base de l'acompte sans l'option", async () => {
    const { id } = await oneOffQuoteWithOption();
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(quote).toMatchObject({ subtotalCents: 120000, totalCents: 120000, depositBaseCents: 120000, paymentPlanOffer: "TWO" });
    expect(quote.lines[1]).toMatchObject({ isOptional: true, optionalAccepted: null, subscriptionStart: "DELIVERY", commitmentMonths: 24, billingInterval: "YEAR" });
    // Échéancier sur la seule partie ponctuelle.
    const milestones = await prisma.paymentMilestone.findMany({ where: { quoteId: id } });
    expect(milestones.reduce((s, m) => s + m.amountCents, 0)).toBe(120000);
  });

  it("refusée en récurrent, sans mode, sur une facture, et seule sur le devis", async () => {
    const client = await createClient({ displayName: "Client Refus Option" });
    const svc = await maintenanceService();
    const recurring = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "RECURRING",
      lines: [{ ...optionLine(svc.id), isOptional: true }],
    });
    expect(recurring.statusCode).toBe(400);
    expect(recurring.json().error).toMatch(/option/);
    const noMode = await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", lines: [site, optionLine(svc.id)] });
    expect(noMode.statusCode).toBe(400);
    const invoice = await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [site, optionLine(svc.id)] });
    expect(invoice.statusCode).toBe(400);
    expect(JSON.stringify(invoice.json())).toMatch(/facture ne porte pas d'option/);
    const alone = await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [optionLine(svc.id)] });
    expect(alone.statusCode).toBe(400);
    expect(alone.json().error).toMatch(/au moins une ligne ponctuelle/);
    const monthly = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "ONE_OFF",
      lines: [site, optionLine(svc.id, { billingInterval: "MONTH" })],
    });
    expect(monthly.statusCode).toBe(400);
    // Abonnement hors option : toujours refusé en paiement unique.
    const plain = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "ONE_OFF",
      lines: [site, optionLine(svc.id, { isOptional: false })],
    });
    expect(plain.statusCode).toBe(400);
  });

  it("modification du brouillon : l'option est gardée, le total reste sans elle", async () => {
    const { id, serviceId } = await oneOffQuoteWithOption({ issue: false });
    const put = await call("PUT", `/api/invoices/${id}`, { lines: [{ ...site, unitPriceEuros: 1500 }, optionLine(serviceId, { commitmentMonths: 36, unitPriceEuros: 280 })] });
    expect(put.statusCode, put.body).toBe(200);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(quote.totalCents).toBe(150000);
    expect(quote.lines[1]).toMatchObject({ isOptional: true, commitmentMonths: 36, unitPriceCents: 28000 });
    // Remise seule : lignes relues, option conservée.
    const discount = await call("PUT", `/api/invoices/${id}`, { discountType: "PERCENT", discountPercent: 10 });
    expect(discount.statusCode, discount.body).toBe(200);
    expect(await prisma.invoiceLine.count({ where: { invoiceId: id, isOptional: true } })).toBe(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).totalCents).toBe(135000);
  });
});

describe("compris et non compris, figés à l'émission", () => {
  it("paiement unique : liste « Non compris » de la clause, une ligne « - » par point", async () => {
    const { id } = await oneOffQuoteWithOption();
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    const scope = quote.scopeSnapshot as { kind: string; included: string[]; excluded: string[] };
    expect(scope.kind).toBe("SITE");
    expect(scope.included).toEqual([]);
    expect(scope.excluded.length).toBe(4);
    expect(scope.excluded[0]).toMatch(/^La maintenance, les mises à jour et les sauvegardes/);
    expect(scope.excluded.some((t) => t.startsWith("- "))).toBe(false);
  });

  it("propositions : abonnement avec la liste de l'offre du site, paiement unique avec la clause ; texte modifié ensuite sans effet", async () => {
    await writeSiteText("offres", OFFRES);
    const client = await createClient({ displayName: "Client Formules" });
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const q = (
      await call("POST", "/api/invoices", {
        clientId: client.id,
        documentType: "QUOTE",
        options: [
          { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [site] },
          {
            label: "Abonnement annuel",
            billingMode: "RECURRING",
            lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 }],
          },
        ],
      })
    ).json();
    expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    await writeSiteText("offres", { ...OFFRES, formules: { ...OFFRES.formules, site: { titre: "x", items: ["Changé après émission"] } } });
    const options = await prisma.quoteOption.findMany({ where: { quoteId: q.id }, orderBy: { position: "asc" } });
    expect((options[0]!.scopeSnapshot as { excluded: string[] }).excluded.length).toBe(4);
    expect(options[1]!.scopeSnapshot).toEqual({ kind: "SITE", included: OFFRES.formules.site.items, excluded: [] });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).scopeSnapshot).toBeNull();
  });

  it("logiciel : formule logiciel et variante logiciel de la clause", async () => {
    await writeSiteText("offres", OFFRES);
    const client = await createClient({ displayName: "Client Logiciel" });
    const soft = await prisma.service.create({ data: { name: "Logiciel sur mesure", unitPriceCents: 300000, category: "LOGICIEL" } });
    const res = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      billingMode: "ONE_OFF",
      lines: [{ description: "Logiciel sur mesure", quantity: 1, unitPriceEuros: 3000, serviceId: soft.id }],
    });
    expect((await call("POST", `/api/invoices/${res.json().id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    const scope = (await prisma.invoice.findUniqueOrThrow({ where: { id: res.json().id } })).scopeSnapshot as { kind: string; excluded: string[] };
    expect(scope.kind).toBe("SOFTWARE");
    expect(scope.excluded.join(" ")).toMatch(/hébergez le logiciel/);
  });
});

describe("aperçu du compris et non compris (formulaire)", () => {
  it("GET /api/invoices/scope-preview : liste selon le mode", async () => {
    await writeSiteText("offres", OFFRES);
    const oneOff = await call("GET", "/api/invoices/scope-preview?mode=ONE_OFF");
    expect(oneOff.statusCode).toBe(200);
    expect(oneOff.json()).toMatchObject({ kind: "SITE", included: [] });
    expect(oneOff.json().excluded.length).toBe(4);
    const recurring = await call("GET", "/api/invoices/scope-preview?mode=RECURRING&serviceIds=");
    expect(recurring.json()).toEqual({ kind: "SITE", included: OFFRES.formules.site.items, excluded: [] });
    expect((await call("GET", "/api/invoices/scope-preview?mode=AUTRE")).statusCode).toBe(400);
  });
});
