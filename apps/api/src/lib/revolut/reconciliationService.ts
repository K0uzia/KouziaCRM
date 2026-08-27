import {
  BankIgnoreCategory,
  BankTxStatus,
  InvoiceDocumentType,
  InvoiceStatus,
  PaymentMethod,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { syncMilestoneOnInvoicePaid } from "@/lib/invoices/documentFlowService.js";

export type MatchSuggestion = {
  invoiceId: string;
  number: string | null;
  clientName: string;
  totalCents: number;
  remainingCents: number;
  deltaCents: number;
  reason: "REFERENCE" | "AMOUNT_CLIENT" | "AMOUNT_NEAR" | "SUBSCRIPTION_ARREARS";
};

const DOC_NUMBER_RE = /\b([FDA])-(\d{4})-(\d{1,8})\b/gi;
const NEAR_CENTS = 500; // 5 €

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

export function normalizeName(s: string): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matching flou: raison sociale, tokens communs, nom inversé. */
export function namesFuzzyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((t) => t.length > 1));
  const tb = new Set(nb.split(" ").filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return false;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const minSize = Math.min(ta.size, tb.size);
  if (common >= Math.max(1, Math.ceil(minSize * 0.6))) return true;
  const ra = na.split(" ").reverse().join(" ");
  return ra === nb || ra.includes(nb) || nb.includes(ra);
}

export function extractDocumentNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  DOC_NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOC_NUMBER_RE.exec(text)) !== null) {
    const prefix = m[1]!.toUpperCase();
    const year = m[2]!;
    const counter = m[3]!.padStart(4, "0");
    found.add(`${prefix}-${year}-${counter}`);
    // Variante sans padding pour matching DB
    found.add(`${prefix}-${year}-${m[3]}`);
  }
  return [...found];
}

type OpenInvoice = {
  id: string;
  number: string | null;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  clientId: string;
  clientName: string;
  clientAliases: string[];
  subscriptionId: string | null;
};

async function loadOpenInvoices(): Promise<OpenInvoice[]> {
  const rows = await prisma.invoice.findMany({
    where: {
      documentType: InvoiceDocumentType.INVOICE,
      status: InvoiceStatus.ISSUED,
      totalCents: { gt: 0 },
    },
    include: {
      payments: { select: { amountCents: true } },
      client: {
        select: {
          id: true,
          displayName: true,
          companyName: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  return rows
    .map((inv) => {
      const paidCents = inv.payments.reduce((s, p) => s + p.amountCents, 0);
      const remainingCents = inv.totalCents - paidCents;
      const aliases = [
        inv.client.displayName,
        inv.client.companyName,
        [inv.client.firstName, inv.client.lastName].filter(Boolean).join(" "),
        [inv.client.lastName, inv.client.firstName].filter(Boolean).join(" "),
      ].filter((x): x is string => Boolean(x?.trim()));
      return {
        id: inv.id,
        number: inv.number,
        totalCents: inv.totalCents,
        paidCents,
        remainingCents,
        clientId: inv.client.id,
        clientName: inv.client.displayName,
        clientAliases: aliases,
        subscriptionId: inv.subscriptionId,
      };
    })
    .filter((i) => i.remainingCents > 0);
}

function clientMatches(inv: OpenInvoice, counterpartyName: string | null): boolean {
  if (!counterpartyName) return false;
  return inv.clientAliases.some((alias) => namesFuzzyMatch(alias, counterpartyName));
}

export async function buildSuggestionsForTx(opts: {
  amountCents: number;
  reference: string | null;
  counterpartyName: string | null;
}): Promise<MatchSuggestion[]> {
  const open = await loadOpenInvoices();
  const suggestions: MatchSuggestion[] = [];
  const seen = new Set<string>();

  const push = (inv: OpenInvoice, reason: MatchSuggestion["reason"]) => {
    if (seen.has(inv.id)) return;
    seen.add(inv.id);
    suggestions.push({
      invoiceId: inv.id,
      number: inv.number,
      clientName: inv.clientName,
      totalCents: inv.totalCents,
      remainingCents: inv.remainingCents,
      deltaCents: opts.amountCents - inv.remainingCents,
      reason,
    });
  };

  const docs = extractDocumentNumbers(opts.reference);
  for (const num of docs) {
    for (const inv of open) {
      if (inv.number && normalizeDocNumber(inv.number) === normalizeDocNumber(num)) {
        push(inv, "REFERENCE");
      }
    }
  }

  for (const inv of open) {
    if (
      inv.remainingCents === opts.amountCents &&
      clientMatches(inv, opts.counterpartyName)
    ) {
      push(inv, "AMOUNT_CLIENT");
    }
  }

  // Arriérés abonnement : N × montant d'échéances ouvertes même abonnement
  if (opts.amountCents > 0) {
    const bySub = new Map<string, OpenInvoice[]>();
    for (const inv of open) {
      if (!inv.subscriptionId) continue;
      if (!clientMatches(inv, opts.counterpartyName) && opts.counterpartyName) {
        // sans match client, on ignore pour éviter faux positifs multi-clients
        continue;
      }
      const list = bySub.get(inv.subscriptionId) ?? [];
      list.push(inv);
      bySub.set(inv.subscriptionId, list);
    }
    for (const list of bySub.values()) {
      if (list.length < 2) continue;
      const sum = list.reduce((s, i) => s + i.remainingCents, 0);
      if (sum === opts.amountCents) {
        for (const inv of list) push(inv, "SUBSCRIPTION_ARREARS");
      }
    }
  }

  for (const inv of open) {
    const delta = Math.abs(opts.amountCents - inv.remainingCents);
    if (delta > 0 && delta <= NEAR_CENTS) {
      push(inv, "AMOUNT_NEAR");
    } else if (inv.remainingCents === opts.amountCents) {
      push(inv, "AMOUNT_NEAR");
    }
  }

  suggestions.sort(
    (a, b) => Math.abs(a.deltaCents) - Math.abs(b.deltaCents) || a.clientName.localeCompare(b.clientName),
  );
  return suggestions.slice(0, 20);
}

function normalizeDocNumber(n: string): string {
  const m = n.trim().toUpperCase().match(/^([FDA])-(\d{4})-(\d+)$/);
  if (!m) return n.trim().toUpperCase();
  return `${m[1]}-${m[2]}-${m[3]!.padStart(4, "0")}`;
}

export type AutoMatchResult =
  | { kind: "matched"; invoiceId: string; reason: "REFERENCE" | "AMOUNT_CLIENT" }
  | { kind: "manual"; suggestions: MatchSuggestion[] }
  | { kind: "unmatched"; suggestions: MatchSuggestion[] };

/**
 * Stratégie 3 niveaux :
 * 1) référence document (auto)
 * 2) montant exact + client flou (auto), sauf arriérés multi-mois
 * 3) UNMATCHED + suggestions (jamais d'auto si écart de montant)
 */
export async function decideAutoMatch(opts: {
  amountCents: number;
  reference: string | null;
  counterpartyName: string | null;
}): Promise<AutoMatchResult> {
  const suggestions = await buildSuggestionsForTx(opts);
  const byRef = suggestions.filter((s) => s.reason === "REFERENCE");
  if (byRef.length === 1 && byRef[0]!.deltaCents === 0) {
    return { kind: "matched", invoiceId: byRef[0]!.invoiceId, reason: "REFERENCE" };
  }
  if (byRef.length === 1 && byRef[0]!.deltaCents !== 0) {
    // Écart : jamais d'auto
    return { kind: "unmatched", suggestions };
  }

  const arrears = suggestions.filter((s) => s.reason === "SUBSCRIPTION_ARREARS");
  if (arrears.length >= 2) {
    return { kind: "manual", suggestions };
  }

  const byAmount = suggestions.filter(
    (s) => s.reason === "AMOUNT_CLIENT" && s.deltaCents === 0,
  );
  if (byAmount.length === 1) {
    return { kind: "matched", invoiceId: byAmount[0]!.invoiceId, reason: "AMOUNT_CLIENT" };
  }

  return { kind: "unmatched", suggestions };
}

export async function applyInvoiceMatch(opts: {
  bankTxId: string;
  invoiceId: string;
  /** Si true, accepte un écart (paiement partiel manuel). */
  allowPartial?: boolean;
  db?: Prisma.TransactionClient | typeof prisma;
}): Promise<{ paymentId: string }> {
  const db = opts.db ?? prisma;
  const tx = await db.bankTransaction.findUnique({ where: { id: opts.bankTxId } });
  if (!tx) throw new Error("Transaction bancaire introuvable");
  if (tx.status === BankTxStatus.MATCHED) throw new Error("Déjà rapprochée");
  if (tx.amountCents <= 0) throw new Error("Seuls les crédits peuvent être rapprochés");

  const invoice = await db.invoice.findUnique({
    where: { id: opts.invoiceId },
    include: { payments: true },
  });
  if (!invoice) throw new Error("Facture introuvable");
  if (invoice.documentType !== InvoiceDocumentType.INVOICE) {
    throw new Error("Rapprochement uniquement sur facture");
  }
  if (invoice.status !== InvoiceStatus.ISSUED && invoice.status !== InvoiceStatus.PAID) {
    throw new Error("Facture non émise");
  }

  const paidSoFar = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const remaining = invoice.totalCents - paidSoFar;
  if (remaining <= 0) throw new Error("Facture déjà soldée");
  if (tx.amountCents > remaining) {
    throw new Error("Montant supérieur au reste dû");
  }
  if (tx.amountCents < remaining && !opts.allowPartial) {
    throw new Error(
      "Écart de montant : rapprochement partiel uniquement en mode manuel explicite",
    );
  }

  const amountCents = Math.min(tx.amountCents, remaining);
  if (amountCents <= 0) throw new Error("Montant invalide");

  const payment = await db.payment.create({
    data: {
      invoiceId: invoice.id,
      amountCents,
      paidAt: tx.bookedAt,
      method: PaymentMethod.BANK_TRANSFER,
      reference: tx.reference ?? tx.revolutId,
      notes: `Rapprochement Revolut ${tx.revolutId}`,
    },
  });

  await db.bankTransaction.update({
    where: { id: tx.id },
    data: {
      status: BankTxStatus.MATCHED,
      matchedInvoiceId: invoice.id,
      paymentId: payment.id,
      ignoreCategory: null,
      suggestionsJson: null,
    },
  });

  if (paidSoFar + amountCents >= invoice.totalCents) {
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.PAID },
    });
    await syncMilestoneOnInvoicePaid(invoice.id, db);
  }

  return { paymentId: payment.id };
}

export async function applyOrphanPayment(opts: {
  bankTxId: string;
  notes?: string | null;
}): Promise<{ paymentId: string }> {
  const tx = await prisma.bankTransaction.findUnique({ where: { id: opts.bankTxId } });
  if (!tx) throw new Error("Transaction bancaire introuvable");
  if (tx.status === BankTxStatus.MATCHED) throw new Error("Déjà rapprochée");
  if (tx.amountCents <= 0) throw new Error("Seuls les crédits peuvent être encaissés");

  const payment = await prisma.payment.create({
    data: {
      invoiceId: null,
      amountCents: tx.amountCents,
      paidAt: tx.bookedAt,
      method: PaymentMethod.BANK_TRANSFER,
      reference: tx.reference ?? tx.revolutId,
      notes: opts.notes ?? "Encaissement sans facture (acompte informel)",
    },
  });

  await prisma.bankTransaction.update({
    where: { id: tx.id },
    data: {
      status: BankTxStatus.MATCHED,
      matchedInvoiceId: null,
      paymentId: payment.id,
      ignoreCategory: null,
      suggestionsJson: null,
    },
  });

  return { paymentId: payment.id };
}

export async function ignoreBankTransaction(opts: {
  bankTxId: string;
  category: BankIgnoreCategory;
}): Promise<void> {
  const tx = await prisma.bankTransaction.findUnique({ where: { id: opts.bankTxId } });
  if (!tx) throw new Error("Transaction bancaire introuvable");
  if (tx.status === BankTxStatus.MATCHED) {
    throw new Error("Impossible d'ignorer une transaction déjà rapprochée");
  }
  await prisma.bankTransaction.update({
    where: { id: tx.id },
    data: {
      status: BankTxStatus.IGNORED,
      ignoreCategory: opts.category,
      matchedInvoiceId: null,
      suggestionsJson: null,
    },
  });
}

/** Applique le matching auto sur les UNMATCHED / PENDING créditeurs. */
export async function reconcileUnmatched(limit = 200): Promise<{
  matchedAuto: number;
  unmatched: number;
}> {
  const rows = await prisma.bankTransaction.findMany({
    where: {
      amountCents: { gt: 0 },
      status: { in: [BankTxStatus.UNMATCHED, BankTxStatus.PENDING] },
      paymentId: null,
    },
    orderBy: { bookedAt: "asc" },
    take: limit,
  });

  let matchedAuto = 0;
  let unmatched = 0;

  for (const row of rows) {
    if (row.revolutState && /pending/i.test(row.revolutState)) {
      await prisma.bankTransaction.update({
        where: { id: row.id },
        data: { status: BankTxStatus.PENDING },
      });
      continue;
    }

    const decision = await decideAutoMatch({
      amountCents: row.amountCents,
      reference: row.reference,
      counterpartyName: row.counterpartyName,
    });

    if (decision.kind === "matched") {
      try {
        await applyInvoiceMatch({
          bankTxId: row.id,
          invoiceId: decision.invoiceId,
          allowPartial: false,
        });
        matchedAuto++;
        continue;
      } catch {
        // tombe en unmatched avec suggestions
      }
    }

    const suggestions =
      decision.kind === "matched"
        ? await buildSuggestionsForTx({
            amountCents: row.amountCents,
            reference: row.reference,
            counterpartyName: row.counterpartyName,
          })
        : decision.suggestions;

    await prisma.bankTransaction.update({
      where: { id: row.id },
      data: {
        status: BankTxStatus.UNMATCHED,
        suggestionsJson: JSON.stringify(suggestions),
      },
    });
    unmatched++;
  }

  return { matchedAuto, unmatched };
}
