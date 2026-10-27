import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MilestoneStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { issueQuote } from "@/lib/invoices/transitions.js";
import { generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import {
  PAYMENT_LINK_HOSTS,
  PAYMENT_LINK_REFUSED,
  normalizePaymentUrl,
  setInvoicePaymentLink,
} from "@/lib/invoices/payment-link.js";
import { setManualMilestonePaymentLink } from "@/lib/payments/milestonePaymentService.js";

// Demande du site (27/10/2026) : Alexandre n'encaisse que par Stripe. Un lien collé à la main n'est accepté que vers un
// hôte Stripe exact (https, sans port ni identifiants) ou l'origine de l'API de l'ERP ; liste du contrat du site
// (contenu.schema.json, « domainesPaiement »), recopiée et tenue par le test de parité.
const fixture = (f: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/site", f), "utf8");

const ORIGIN = process.env.PUBLIC_API_ORIGIN;
beforeEach(async () => {
  process.env.PUBLIC_API_ORIGIN = "https://api.kouzia.test";
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  if (ORIGIN === undefined) delete process.env.PUBLIC_API_ORIGIN;
  else process.env.PUBLIC_API_ORIGIN = ORIGIN;
  await resetDb();
});

async function signedQuote() {
  const client = await createClient();
  const q = await prisma.invoice.create({
    data: {
      documentType: "QUOTE",
      invoiceType: "SIMPLE",
      status: "DRAFT",
      clientId: client.id,
      subtotalCents: 100_000,
      totalCents: 100_000,
      quoteStatus: QuoteStatus.DRAFT,
      lines: { create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000 }] },
    },
  });
  await issueQuote(q.id);
  await prisma.invoice.update({ where: { id: q.id }, data: { quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date() } });
  return q.id;
}

describe("liens de paiement : Stripe ou l'ERP seulement", () => {
  it("même liste que le contrat du site (domainesPaiement)", () => {
    const contrat = JSON.parse(fixture("domaines-paiement.e81aa9a.json")) as { domainesPaiement: { protocole: string; hotes: string[]; origineApiErp: boolean } };
    expect(contrat.domainesPaiement.protocole).toBe("https:");
    expect([...PAYMENT_LINK_HOSTS].sort()).toEqual([...contrat.domainesPaiement.hotes].sort());
    expect(contrat.domainesPaiement.origineApiErp).toBe(true);
  });

  it("accepte les hôtes Stripe exacts et l'origine de l'API de l'ERP", () => {
    for (const url of [
      "https://checkout.stripe.com/c/pay/cs_live_abc",
      "https://billing.stripe.com/p/session/abc",
      "https://buy.stripe.com/abc123",
      "https://api.kouzia.test/api/public/pay/jeton",
    ]) {
      expect(normalizePaymentUrl(url)).toBe(url);
    }
  });

  it("refuse tout autre lien, avec le message attendu", () => {
    for (const url of [
      "https://checkout.revolut.com/pay/abc",
      "https://revolut.me/kouzia",
      "https://paypal.me/kouzia",
      "https://checkout.stripe.com.exemple.fr/pay",
      "https://faux-checkout.stripe.com/pay",
      "https://stripe.com/pay",
      "https://checkout.stripe.com:8443/c/pay/abc",
      "https://pirate@checkout.stripe.com/c/pay/abc",
      "https://user:pass@buy.stripe.com/abc",
      "https://api.kouzia.test:8443/api/public/pay/jeton",
      "https://autre.kouzia.test/api/public/pay/jeton",
    ]) {
      expect(() => normalizePaymentUrl(url), url).toThrow(PAYMENT_LINK_REFUSED);
    }
    expect(PAYMENT_LINK_REFUSED).toBe(
      "Lien refusé : seuls les liens Stripe (checkout.stripe.com, billing.stripe.com, buy.stripe.com) ou ceux de l'ERP sont acceptés.",
    );
  });

  it("facture : un lien hors liste est refusé en 400 sans rien enregistrer", async () => {
    const quoteId = await signedQuote();
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 1 } });
    const inv = await generateMilestoneInvoice(deposit.id);
    await expect(setInvoicePaymentLink(inv.id, "https://checkout.revolut.com/pay/abc")).rejects.toMatchObject({ statusCode: 400, message: PAYMENT_LINK_REFUSED });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).checkoutUrl).toBeNull();
    expect(await setInvoicePaymentLink(inv.id, "https://buy.stripe.com/abc")).toBe("https://buy.stripe.com/abc");
  });

  it("échéance de devis : un lien collé hors liste est refusé en 400 sans rien enregistrer", async () => {
    const quoteId = await signedQuote();
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 1 } });
    await expect(setManualMilestonePaymentLink(deposit.id, "https://revolut.me/kouzia", { sendEmail: false })).rejects.toMatchObject({ statusCode: 400, message: PAYMENT_LINK_REFUSED });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: deposit.id } })).checkoutUrl).toBeNull();
  });
});
