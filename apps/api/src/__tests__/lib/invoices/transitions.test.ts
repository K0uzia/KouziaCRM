import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  QuoteStatus,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  issueInvoice,
  issueQuote,
  convertQuoteToInvoice,
  rejectQuote,
  acceptQuoteByClient,
  repairQuotesMissingNumbers,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";
import { resetDb } from "../../helpers/db.js";
import {
  seedCompanySettings,
  createClient,
  createService,
} from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

async function createDraftInvoice(opts: {
  documentType: InvoiceDocumentType;
  clientId: string;
  lines: Array<{
    description: string;
    unitPriceCents: number;
    quantity?: number;
    isSubscription?: boolean;
    billingDay?: number | null;
    serviceId?: string | null;
  }>;
}): Promise<string> {
  const inv = await prisma.invoice.create({
    data: {
      documentType: opts.documentType,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.DRAFT,
      clientId: opts.clientId,
      subtotalCents: opts.lines.reduce((s, l) => s + l.unitPriceCents * (l.quantity ?? 1), 0),
      totalCents: opts.lines.reduce((s, l) => s + l.unitPriceCents * (l.quantity ?? 1), 0),
      lines: {
        create: opts.lines.map((l, i) => ({
          position: i + 1,
          description: l.description,
          quantity: l.isSubscription ? 1 : (l.quantity ?? 1),
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.unitPriceCents * (l.isSubscription ? 1 : (l.quantity ?? 1)),
          isSubscription: l.isSubscription ?? false,
          billingDay: l.billingDay ?? null,
          serviceId: l.serviceId ?? null,
        })),
      },
    },
  });
  return inv.id;
}

describe("issueInvoice", () => {
  it("alloue un numéro, passe en ISSUED et fige le clientSnapshot", async () => {
    const client = await createClient({ displayName: "Acme SARL" });
    const id = await createDraftInvoice({
      documentType: InvoiceDocumentType.INVOICE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 50000 }],
    });

    const issueDate = new Date(2026, 5, 15);
    const issued = await issueInvoice(id, issueDate, issueDate);

    expect(issued.status).toBe(InvoiceStatus.ISSUED);
    expect(issued.number).toMatch(/^F-2026-\d{4}$/);
    expect(issued.sequenceYear).toBe(2026);
    expect(issued.sequenceNumber).toBe(1);
    expect(issued.issueDate?.toISOString()).toBe(issueDate.toISOString());
    expect(issued.issuedAt).toBeTruthy();
    expect(issued.clientSnapshot).toBeTruthy();
    expect(issued.subscriptionsCreated).toBe(0);
  });

  it("rejette l'émission d'un document déjà émis (immutabilité)", async () => {
    const client = await createClient();
    const id = await createDraftInvoice({
      documentType: InvoiceDocumentType.INVOICE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 50000 }],
    });
    await issueInvoice(id, new Date(2026, 5, 15));
    await expect(issueInvoice(id, new Date(2026, 5, 16))).rejects.toThrow(
      /Seuls les brouillons/,
    );
  });

  it("rejette l'émission d'une facture sans lignes", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: client.id,
      },
    });
    await expect(issueInvoice(inv.id)).rejects.toThrow(/sans lignes/);
  });

  it("rejette l'émission d'un devis via issueInvoice", async () => {
    const client = await createClient();
    const id = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 50000 }],
    });
    await expect(issueInvoice(id)).rejects.toThrow(/Document invalide/);
  });

  it("incrémente le compteur de séquence sur plusieurs émissions", async () => {
    const c1 = await createClient({ displayName: "A" });
    const c2 = await createClient({ displayName: "B" });
    const id1 = await createDraftInvoice({
      documentType: InvoiceDocumentType.INVOICE,
      clientId: c1.id,
      lines: [{ description: "X", unitPriceCents: 1000 }],
    });
    const id2 = await createDraftInvoice({
      documentType: InvoiceDocumentType.INVOICE,
      clientId: c2.id,
      lines: [{ description: "Y", unitPriceCents: 1000 }],
    });
    const d = new Date(2026, 5, 15);
    const a = await issueInvoice(id1, d);
    const b = await issueInvoice(id2, d);
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(2);
    expect(a.number).not.toBe(b.number);
  });

  it("active un abonnement depuis une ligne abonnement et le lie à la ligne", async () => {
    const client = await createClient();
    const service = await createService();
    const id = await createDraftInvoice({
      documentType: InvoiceDocumentType.INVOICE,
      clientId: client.id,
      lines: [
        {
          description: "Maintenance mensuelle",
          unitPriceCents: 30000,
          isSubscription: true,
          billingDay: 1,
          serviceId: service.id,
        },
      ],
    });

    const issued = await issueInvoice(id, new Date(2026, 5, 15));
    expect(issued.subscriptionsCreated).toBe(1);

    const sub = await prisma.subscription.findFirst({
      where: { clientId: client.id },
    });
    expect(sub).toBeTruthy();
    expect(sub!.status).toBe(SubscriptionStatus.ACTIVE);
    expect(sub!.amountCents).toBe(30000);
    expect(sub!.billingDay).toBe(1);

    const expectedNextMonth = (new Date().getMonth() + 1) % 12;
    expect(sub!.nextInvoiceAt.getMonth()).toBe(expectedNextMonth);

    const line = await prisma.invoiceLine.findFirst({
      where: { invoiceId: id, isSubscription: true },
    });
    expect(line?.subscriptionId).toBe(sub!.id);
  });
});

describe("issueQuote", () => {
  it("alloue un numéro D-YYYY-NNNN et passe en SENT", async () => {
    const client = await createClient();
    const id = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 100000 }],
    });
    const issueDate = new Date(2026, 5, 15);
    const quote = await issueQuote(id, issueDate);
    expect(quote.status).toBe(InvoiceStatus.ISSUED);
    expect(quote.quoteStatus).toBe(QuoteStatus.SENT);
    expect(quote.number).toMatch(/^D-2026-\d{4}$/);
    expect(quote.validUntil).toBeTruthy();
  });
});

describe("convertQuoteToInvoice", () => {
  it("crée une facture SIMPLE brouillon liée au devis et marque le devis ACCEPTED", async () => {
    const client = await createClient();
    const quoteId = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 100000 }],
    });
    await issueQuote(quoteId, new Date(2026, 5, 15));

    const result = await convertQuoteToInvoice(quoteId);
    expect(result.documentType).toBe(InvoiceDocumentType.INVOICE);
    expect(result.invoiceType).toBe(InvoiceType.SIMPLE);
    expect(result.status).toBe(InvoiceStatus.DRAFT);
    expect(result.quoteId).toBe(quoteId);
    expect(result.sourceQuoteId).toBe(quoteId);
    expect(result.totalCents).toBe(100000);

    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.quoteStatus).toBe(QuoteStatus.ACCEPTED);
    expect(quote.status).toBe(InvoiceStatus.PAID);
  });

  it("propage les lignes abonnement et leur subscriptionId vers la facture", async () => {
    const client = await createClient();
    const service = await createService();
    const quoteId = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [
        {
          description: "Maintenance mensuelle",
          unitPriceCents: 30000,
          isSubscription: true,
          billingDay: 1,
          serviceId: service.id,
        },
        { description: "Setup", unitPriceCents: 80000, quantity: 1 },
      ],
    });
    await issueQuote(quoteId, new Date(2026, 5, 15));

    const result = await convertQuoteToInvoice(quoteId);
    expect(result.subscriptionsCreated).toBe(1);

    const invLines = await prisma.invoiceLine.findMany({
      where: { invoiceId: result.id },
      orderBy: { position: "asc" },
    });
    expect(invLines).toHaveLength(2);
    expect(invLines[0]!.isSubscription).toBe(true);
    expect(invLines[0]!.subscriptionId).toBeTruthy();
    expect(invLines[1]!.isSubscription).toBe(false);

    const quoteLines = await prisma.invoiceLine.findMany({
      where: { invoiceId: quoteId, isSubscription: true },
    });
    expect(quoteLines[0]!.subscriptionId).toBe(invLines[0]!.subscriptionId);
  });

  it("rejette la double conversion d'un devis", async () => {
    const client = await createClient();
    const quoteId = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 50000 }],
    });
    await issueQuote(quoteId, new Date(2026, 5, 15));
    await convertQuoteToInvoice(quoteId);
    await expect(convertQuoteToInvoice(quoteId)).rejects.toThrow(
      /Devis non convertible/,
    );
  });
});

describe("décision du client sur un devis", () => {
  async function issuedQuote(): Promise<string> {
    const client = await createClient();
    const quoteId = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 100000 }],
    });
    await issueQuote(quoteId, new Date(2026, 5, 15));
    return quoteId;
  }

  async function markFirstDepositPaid(quoteId: string): Promise<void> {
    const first = await prisma.paymentMilestone.findFirst({
      where: { quoteId },
      orderBy: { position: "asc" },
    });
    if (!first) throw new Error("Jalon acompte introuvable");
    await prisma.paymentMilestone.update({
      where: { id: first.id },
      data: { status: MilestoneStatus.PAID, paidAt: new Date() },
    });
  }

  it("refuse un devis envoyé, le clôt et conserve le motif", async () => {
    const quoteId = await issuedQuote();
    const rejected = await rejectQuote(quoteId, "  Budget trop élevé  ");

    expect(rejected.quoteStatus).toBe(QuoteStatus.REJECTED);
    expect(rejected.status).toBe(InvoiceStatus.CANCELLED);
    expect(rejected.quoteRejectReason).toBe("Budget trop élevé");
    expect(rejected.quoteDecidedAt).toBeTruthy();
  });

  it("laisse le motif vide quand aucun n'est saisi", async () => {
    const quoteId = await issuedQuote();
    const rejected = await rejectQuote(quoteId, "   ");
    expect(rejected.quoteRejectReason).toBeNull();
  });

  it("interdit de facturer un devis refusé", async () => {
    const quoteId = await issuedQuote();
    await rejectQuote(quoteId);
    await expect(convertQuoteToInvoice(quoteId)).rejects.toThrow(/non convertible/);
  });

  it("accepte un devis sans acompte payé (validation d'abord)", async () => {
    const quoteId = await issuedQuote();
    const accepted = await acceptQuoteByClient(quoteId, " Camille Dupont ");

    expect(accepted.quoteStatus).toBe(QuoteStatus.ACCEPTED);
    expect(accepted.quoteSignerName).toBe("Camille Dupont");
    expect(accepted.status).toBe(InvoiceStatus.ISSUED);
  });

  it("crée un acompte et un solde à l'émission, sans jalon intermédiaire", async () => {
    const quoteId = await issuedQuote();
    const milestones = await prisma.paymentMilestone.findMany({
      where: { quoteId },
      orderBy: { position: "asc" },
    });
    expect(milestones).toHaveLength(2);
    expect(milestones.map((m) => m.label)).toEqual(["Acompte", "Solde"]);
    expect(milestones[0]?.percentBps).toBe(3000);
    expect(milestones[1]?.percentBps).toBe(7000);
    expect(milestones[0]?.checkoutUrl).toBeNull();
  });

  it("accepte un devis en ligne même si l'acompte est déjà payé", async () => {
    const quoteId = await issuedQuote();
    await markFirstDepositPaid(quoteId);
    const accepted = await acceptQuoteByClient(quoteId, " Camille Dupont ");

    expect(accepted.quoteStatus).toBe(QuoteStatus.ACCEPTED);
    expect(accepted.quoteSignerName).toBe("Camille Dupont");
    expect(accepted.status).toBe(InvoiceStatus.ISSUED);
  });

  it("permet de facturer un devis accepté par le client", async () => {
    const quoteId = await issuedQuote();
    await acceptQuoteByClient(quoteId, "Camille Dupont");
    const invoice = await convertQuoteToInvoice(quoteId);
    expect(invoice.documentType).toBe(InvoiceDocumentType.INVOICE);
  });

  it("refuse une seconde décision sur un devis déjà tranché", async () => {
    const quoteId = await issuedQuote();
    await acceptQuoteByClient(quoteId, "Camille Dupont");
    await expect(rejectQuote(quoteId)).rejects.toThrow(QuoteDecisionError);
  });

  it("répare un devis accepté sans numéro", async () => {
    const client = await createClient();
    const quoteId = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 100000 }],
    });
    await prisma.invoice.update({
      where: { id: quoteId },
      data: { quoteStatus: QuoteStatus.ACCEPTED, status: InvoiceStatus.PAID },
    });
    const n = await repairQuotesMissingNumbers();
    expect(n).toBeGreaterThanOrEqual(1);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.number).toMatch(/^D-\d{4}-\d+/);
  });

  it("refuse une décision sur un brouillon jamais envoyé", async () => {
    const client = await createClient();
    const quoteId = await createDraftInvoice({
      documentType: InvoiceDocumentType.QUOTE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 100000 }],
    });
    await expect(rejectQuote(quoteId)).rejects.toThrow(/envoyé/);
  });

  it("refuse une décision sur une facture", async () => {
    const client = await createClient();
    const invoiceId = await createDraftInvoice({
      documentType: InvoiceDocumentType.INVOICE,
      clientId: client.id,
      lines: [{ description: "Mission", unitPriceCents: 100000 }],
    });
    await expect(rejectQuote(invoiceId)).rejects.toThrow(/n'est pas un devis/);
  });
});
