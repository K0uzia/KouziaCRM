import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => false,
}));
// Un pack n'est jamais envoyé à Stripe : tout appel ferait échouer le test.
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => {
    throw new Error("Stripe ne doit pas être appelé pour un pack");
  }),
}));

const { buildApp } = await import("@/app.js");
const { issueQuote, acceptQuoteByClient, convertQuoteToInvoice } = await import("@/lib/invoices/transitions.js");

const ADMIN = "admin-packs@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  // Module Stripe actif : le pack doit rester local quand même.
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true } });
  invalidateCompanySettingsCache();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

/** Catalogue fictif (montants de test, pas la grille réelle). */
async function catalogue() {
  const base = { unit: "FORFAIT" as const, active: true };
  const site = await prisma.service.create({ data: { ...base, name: "Site de test", unitPriceCents: 100_000 } });
  const fiche = await prisma.service.create({ data: { ...base, name: "Fiche de test", unitPriceCents: 10_000 } });
  const maint = await prisma.service.create({
    data: { ...base, name: "Maintenance de test", description: "Mises à jour", unitPriceCents: 30_000, isSubscription: true, billingInterval: "YEAR", defaultBillingDay: 5 },
  });
  return { site, fiche, maint };
}

const packBody = (items: Array<{ serviceId: string; quantity?: number }>, unitPriceEuros: number) => ({
  name: "Pack de test",
  description: "Site, fiche et maintenance",
  unitPriceEuros,
  isPack: true,
  packItems: items.map((i) => ({ quantity: 1, ...i })),
});

describe("packs", () => {
  it("création sans Stripe, lignes du devis : détail au prix, abonnement au prix plein, remise du pack", async () => {
    const { site, fiche, maint } = await catalogue();
    const res = await call("POST", "/api/services", packBody([{ serviceId: site.id }, { serviceId: fiche.id }, { serviceId: maint.id }], 1050));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ isPack: true, isSubscription: false, unitPriceCents: 105_000, stripeProductId: null });
    const lines = (await call("GET", `/api/services/${res.json().id}/pack-lines`)).json() as Array<Record<string, unknown>>;
    expect(lines.map((l) => [l.description, l.unitPriceCents, l.isSubscription, l.isPackDiscount])).toEqual([
      ["Site de test", 100_000, false, false],
      ["Fiche de test", 10_000, false, false],
      ["Maintenance de test : Mises à jour", 30_000, true, false],
      ["Remise Pack de test", -5_000, false, true],
    ]);
    expect(lines.every((l) => l.groupTitle === "Pack de test")).toBe(true);
    expect(lines[2]).toMatchObject({ billingInterval: "YEAR", billingDay: 5 });
    // Liste du catalogue : le pack porte son contenu.
    const listed = ((await call("GET", "/api/services")).json() as Array<{ id: string; packItems: unknown[] }>).find((s) => s.id === res.json().id);
    expect(listed?.packItems).toHaveLength(3);
  });

  it("règles : ni pack dans un pack, ni doublon ; prix et contenu libres (mode de facturation, 24/10/2026)", async () => {
    const { site, fiche, maint } = await catalogue();
    // Le contenu d'un pack est descriptif : prix d'achat au-dessus du détail et pack d'abonnements seuls acceptés.
    expect((await call("POST", "/api/services", packBody([{ serviceId: site.id }], 1500))).statusCode).toBe(201);
    expect((await call("POST", "/api/services", packBody([{ serviceId: maint.id }], 100))).statusCode).toBe(201);
    expect((await call("POST", "/api/services", packBody([{ serviceId: site.id }, { serviceId: site.id }], 900))).json().error).toMatch(/deux fois/);
    const pack = (await call("POST", "/api/services", packBody([{ serviceId: site.id }, { serviceId: fiche.id }], 1050))).json();
    expect((await call("POST", "/api/services", packBody([{ serviceId: pack.id }], 100))).json().error).toMatch(/autre pack/);
    // Modification : composition remplacée ; un pack ne devient pas une prestation.
    const put = await call("PUT", `/api/services/${pack.id}`, packBody([{ serviceId: site.id, quantity: 2 }], 1900));
    expect(put.statusCode).toBe(200);
    expect(await prisma.servicePackItem.findMany({ where: { packId: pack.id } })).toEqual([expect.objectContaining({ serviceId: site.id, quantity: 2 })]);
    expect((await call("PUT", `/api/services/${pack.id}`, { name: "x", unitPriceEuros: 1 })).statusCode).toBe(400);
  });

  it("suppression : une prestation d'un pack est archivée ; le pack lui-même est supprimé", async () => {
    const { site, fiche } = await catalogue();
    const pack = (await call("POST", "/api/services", packBody([{ serviceId: site.id }, { serviceId: fiche.id }], 1050))).json();
    expect((await call("DELETE", `/api/services/${fiche.id}`)).json()).toEqual({ ok: true, archived: true });
    expect((await call("DELETE", `/api/services/${pack.id}`)).json()).toEqual({ ok: true, archived: false });
    expect(await prisma.servicePackItem.count()).toBe(0);
  });

  it("devis avec un pack : titre et remise gardés jusqu'à la facture ; remise du pack sur la partie ponctuelle", async () => {
    const { site, fiche, maint } = await catalogue();
    const pack = (await call("POST", "/api/services", packBody([{ serviceId: site.id }, { serviceId: fiche.id }, { serviceId: maint.id }], 1050))).json();
    const packLines = (await call("GET", `/api/services/${pack.id}/pack-lines`)).json() as Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      isSubscription: boolean;
      billingInterval: string | null;
      billingDay: number | null;
      serviceId: string;
      groupTitle: string;
      isPackDiscount: boolean;
    }>;
    const client = await createClient();
    const res = await call("POST", "/api/invoices", {
      documentType: "QUOTE",
      clientId: client.id,
      lines: packLines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceEuros: l.unitPriceCents / 100,
        isSubscription: l.isSubscription,
        billingDay: l.billingDay,
        billingInterval: l.billingInterval,
        serviceId: l.isSubscription ? l.serviceId : null,
        groupTitle: l.groupTitle,
        isPackDiscount: l.isPackDiscount,
        ...(l.isSubscription ? { commitmentMonths: 12 } : {}),
      })),
    });
    expect(res.statusCode).toBe(201);
    const quote = res.json();
    // Ponctuel 1 100 € - remise 50 € = 1 050 € ; abonnement à son prix plein, inclus dans le devis.
    expect(quote).toMatchObject({ subtotalCents: 135_000, totalCents: 135_000 });
    expect(quote.lines.filter((l: { groupTitle: string }) => l.groupTitle === "Pack de test")).toHaveLength(4);
    expect(quote.lines.find((l: { isPackDiscount: boolean }) => l.isPackDiscount)).toMatchObject({ lineTotalCents: -5_000 });

    // Une remise de pack sur un abonnement, ou positive, est refusée.
    const bad = await call("POST", "/api/invoices", {
      documentType: "QUOTE",
      clientId: client.id,
      lines: [{ description: "Remise", quantity: 1, unitPriceEuros: 10, isPackDiscount: true }],
    });
    expect(bad.statusCode).toBe(400);

    const issued = await issueQuote(quote.id);
    expect(issued.depositBaseCents).toBe(105_000);
    // PDF : rendu avec le titre du pack au-dessus de ses lignes (aucune erreur de rendu).
    const pdf = await call("GET", `/api/invoices/${quote.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/pdf/);
    expect(pdf.rawPayload.length).toBeGreaterThan(1000);
    // Devis mixte : deux totaux, le projet (base de l'acompte) puis l'abonnement avec son départ.
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({ data: new Uint8Array(pdf.rawPayload) }).promise;
    let texte = "";
    for (let n = 1; n <= doc.numPages; n++) {
      texte += (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ") + " ";
    }
    texte = texte.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ");
    expect(texte).toMatch(/Total du projet 1 050,00 €/);
    expect(texte).toMatch(/Abonnement 300,00 € par an à partir de la livraison du projet/);
    expect(texte).not.toMatch(/Net à payer/);
    await acceptQuoteByClient(quote.id, "Lou Pack", { source: "ADMIN" });
    const invoice = await convertQuoteToInvoice(quote.id);
    const invLines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id }, orderBy: { position: "asc" } });
    expect(invLines.filter((l) => !l.isSubscription).map((l) => [l.description, l.groupTitle, l.isPackDiscount])).toEqual([
      ["Site de test", "Pack de test", false],
      ["Fiche de test", "Pack de test", false],
      ["Remise Pack de test", "Pack de test", true],
    ]);
  });
});
