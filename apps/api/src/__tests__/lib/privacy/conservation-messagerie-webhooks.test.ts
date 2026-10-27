import { beforeEach, describe, expect, it } from "vitest";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { purgeRetention } from "@/lib/privacy/retention.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 : messagerie gardée 3 ans après le dernier échange avec le contact, contenu brut
// des webhooks Stripe et Revolut 1 an (la ligne reste), puis purge par le worker.
const NOW = new Date(2030, 5, 1, 12, 0);
const YEARS = (n: number) => new Date(NOW.getFullYear() - n, NOW.getMonth(), NOW.getDate() - 1);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { email: "contact@kouzia.test" } });
});

async function thread(at: Date, participants: string[], clientId: string | null = null) {
  return prisma.emailThread.create({
    data: {
      subject: "Échange",
      participants: JSON.stringify(participants),
      lastMessageAt: at,
      clientId,
      messages: {
        create: [{ direction: EmailDirection.INBOUND, messageId: `<${Math.random()}@test>`, fromAddress: participants[0]!, toAddresses: "[]", subject: "Échange", receivedAt: at, bodyText: "Bonjour" }],
      },
    },
  });
}

const exists = async (id: string) => (await prisma.emailThread.count({ where: { id } })) === 1;

describe("messagerie : 3 ans après le dernier échange avec le contact", () => {
  it("fil de plus de 3 ans sans échange plus récent : retiré, messages compris", async () => {
    const old = await thread(YEARS(4), ["ancien@exemple.fr", "contact@kouzia.test"]);
    const kept = await thread(YEARS(2), ["recent@exemple.fr", "contact@kouzia.test"]);
    const result = await purgeRetention(NOW);
    expect(result.mailThreads).toBe(1);
    expect(await exists(old.id)).toBe(false);
    expect(await prisma.emailMessage.count({ where: { threadId: old.id } })).toBe(0);
    expect(await exists(kept.id)).toBe(true);
  });

  it("vieux fil d'un contact qui a écrit depuis (même adresse ou même fiche client) : gardé", async () => {
    const client = await createClient({ displayName: "Client Fidèle" });
    const byAddress = await thread(YEARS(5), ["fidele@exemple.fr", "contact@kouzia.test"]);
    await thread(YEARS(1), ["fidele@exemple.fr", "contact@kouzia.test"]);
    const byClient = await thread(YEARS(5), ["ancienne-adresse@exemple.fr"], client.id);
    await thread(YEARS(1), ["nouvelle-adresse@exemple.fr"], client.id);
    expect((await purgeRetention(NOW)).mailThreads).toBe(0);
    expect(await exists(byAddress.id)).toBe(true);
    expect(await exists(byClient.id)).toBe(true);
  });

  it("l'adresse de l'ERP, présente partout, ne garde pas un vieux fil", async () => {
    const old = await thread(YEARS(4), ["parti@exemple.fr", "contact@kouzia.test"]);
    await thread(YEARS(1), ["autre@exemple.fr", "contact@kouzia.test"]);
    await purgeRetention(NOW);
    expect(await exists(old.id)).toBe(false);
  });
});

describe("pièces comptables et preuves : 10 ans après la clôture de l'exercice", () => {
  async function issuedQuote(clientId: string, issueDate: Date) {
    return prisma.invoice.create({
      data: { clientId, documentType: "QUOTE", status: "ISSUED", quoteStatus: "ACCEPTED", number: `D-${issueDate.getFullYear()}-${Math.floor(Math.random() * 9999)}`, issueDate, subtotalCents: 100, totalCents: 100 },
    });
  }

  it("preuve de signature de 2019 supprimée le 1er janvier 2030, celle de 2020 gardée ; client ancien anonymisé, récent gardé", async () => {
    const oldClient = await createClient({ displayName: "Client 2019" });
    await prisma.client.update({ where: { id: oldClient.id }, data: { firstName: "Ancien", updatedAt: YEARS(9) } });
    const oldQuote = await issuedQuote(oldClient.id, new Date(2019, 11, 31));
    await prisma.quoteAcceptanceAudit.create({ data: { quoteId: oldQuote.id, signerName: "Ancien", source: "PORTAL", createdAt: new Date(2019, 11, 31) } });
    const keptClient = await createClient({ displayName: "Client 2020" });
    await prisma.client.update({ where: { id: keptClient.id }, data: { updatedAt: YEARS(9) } });
    const keptQuote = await issuedQuote(keptClient.id, new Date(2020, 0, 2));
    await prisma.quoteAcceptanceAudit.create({ data: { quoteId: keptQuote.id, signerName: "Récent", source: "PORTAL", createdAt: new Date(2020, 0, 2) } });

    const result = await purgeRetention(NOW);
    expect(result.acceptanceProofs).toBe(1);
    expect(await prisma.quoteAcceptanceAudit.count({ where: { quoteId: oldQuote.id } })).toBe(0);
    expect(await prisma.quoteAcceptanceAudit.count({ where: { quoteId: keptQuote.id } })).toBe(1);
    expect(result.expiredClients).toBe(1);
    const anonymized = await prisma.client.findUniqueOrThrow({ where: { id: oldClient.id } });
    expect([anonymized.displayName.startsWith("Client effacé"), anonymized.firstName]).toEqual([true, null]);
    // La ligne comptable reste (numéro, montant).
    expect(await prisma.invoice.count({ where: { id: oldQuote.id } })).toBe(1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: keptClient.id } })).displayName).toBe("Client 2020");
    expect((await purgeRetention(NOW)).expiredClients).toBe(0);
  });
});

describe("webhooks : contenu brut 1 an", () => {
  it("vidé au-delà d'un an, ligne gardée (idempotence) ; récent intact", async () => {
    await prisma.stripeWebhookEvent.create({ data: { eventId: "evt_vieux", eventType: "invoice.paid", payload: { customer_email: "lea@exemple.fr" }, processedAt: YEARS(2) } });
    await prisma.stripeWebhookEvent.create({ data: { eventId: "evt_recent", eventType: "invoice.paid", payload: { customer_email: "paul@exemple.fr" }, processedAt: YEARS(0) } });
    await prisma.revolutWebhookEvent.create({ data: { eventId: "rev_vieux", eventType: "ORDER_COMPLETED", payload: { email: "lea@exemple.fr" }, processedAt: YEARS(2) } });
    expect((await purgeRetention(NOW)).webhookPayloads).toBe(2);
    expect((await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt_vieux" } })).payload).toEqual({});
    expect((await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt_recent" } })).payload).toEqual({ customer_email: "paul@exemple.fr" });
    expect((await prisma.revolutWebhookEvent.findUniqueOrThrow({ where: { eventId: "rev_vieux" } })).payload).toEqual({});
    expect((await purgeRetention(NOW)).webhookPayloads).toBe(0);
  });
});
