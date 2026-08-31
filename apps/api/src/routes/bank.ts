import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { BankIgnoreCategory, BankTxStatus } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { importTransactions } from "@/lib/revolut/importTransactions.js";
import {
  applyInvoiceMatch,
  applyOrphanPayment,
  buildSuggestionsForTx,
  decideAutoMatch,
  ignoreBankTransaction,
  listOpenInvoicesForMatch,
} from "@/lib/revolut/reconciliationService.js";
import {
  getLastPollAtMs,
  getRevolutEnv,
  isRevolutConfigured,
} from "@/lib/revolut/revolutService.js";

function serializeTx(row: {
  id: string;
  revolutId: string;
  bookedAt: Date;
  amountCents: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  reference: string | null;
  revolutState: string | null;
  status: BankTxStatus;
  ignoreCategory: BankIgnoreCategory | null;
  matchedInvoiceId: string | null;
  paymentId: string | null;
  suggestionsJson: string | null;
  createdAt: Date;
  updatedAt: Date;
  matchedInvoice?: { id: string; number: string | null } | null;
}) {
  let suggestions = null;
  if (row.suggestionsJson) {
    try {
      suggestions = JSON.parse(row.suggestionsJson);
    } catch {
      suggestions = null;
    }
  }
  return {
    id: row.id,
    revolutId: row.revolutId,
    bookedAt: row.bookedAt.toISOString(),
    amountCents: row.amountCents,
    currency: row.currency,
    counterpartyName: row.counterpartyName,
    counterpartyIban: row.counterpartyIban,
    reference: row.reference,
    revolutState: row.revolutState,
    status: row.status,
    ignoreCategory: row.ignoreCategory,
    matchedInvoiceId: row.matchedInvoiceId,
    paymentId: row.paymentId,
    suggestions,
    matchedInvoice: row.matchedInvoice
      ? { id: row.matchedInvoice.id, number: row.matchedInvoice.number }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const bankRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/bank/status", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const unmatched = await prisma.bankTransaction.count({
      where: { status: BankTxStatus.UNMATCHED, amountCents: { gt: 0 } },
    });
    const lastLog = await prisma.bankSyncLog.findFirst({
      orderBy: { startedAt: "desc" },
    });
    return {
      configured: isRevolutConfigured(),
      env: getRevolutEnv(),
      unmatchedCount: unmatched,
      lastPollAt: getLastPollAtMs()
        ? new Date(getLastPollAtMs()).toISOString()
        : null,
      lastSync: lastLog
        ? {
            id: lastLog.id,
            startedAt: lastLog.startedAt.toISOString(),
            finishedAt: lastLog.finishedAt?.toISOString() ?? null,
            imported: lastLog.imported,
            updated: lastLog.updated,
            matchedAuto: lastLog.matchedAuto,
            unmatched: lastLog.unmatched,
            errorMessage: lastLog.errorMessage,
          }
        : null,
    };
  });

  app.get("/api/bank/open-invoices", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listOpenInvoicesForMatch();
  });

  app.get("/api/bank/transactions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as {
      status?: string;
      limit?: string;
      feesOnly?: string;
    };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
    const where: {
      status?: BankTxStatus;
      ignoreCategory?: BankIgnoreCategory;
      amountCents?: { gt: number };
    } = {};

    if (q.feesOnly === "1" || q.feesOnly === "true") {
      where.status = BankTxStatus.IGNORED;
      where.ignoreCategory = BankIgnoreCategory.FRAIS_BANCAIRES;
    } else if (q.status && Object.values(BankTxStatus).includes(q.status as BankTxStatus)) {
      where.status = q.status as BankTxStatus;
      if (q.status === BankTxStatus.UNMATCHED) {
        where.amountCents = { gt: 0 };
      }
    }

    const rows = await prisma.bankTransaction.findMany({
      where,
      orderBy: { bookedAt: "desc" },
      take: limit,
      include: {
        matchedInvoice: { select: { id: true, number: true } },
      },
    });

    const creditSum = await prisma.bankTransaction.aggregate({
      where: { amountCents: { gt: 0 }, status: { not: BankTxStatus.IGNORED } },
      _sum: { amountCents: true },
    });
    const unmatchedCount = await prisma.bankTransaction.count({
      where: { status: BankTxStatus.UNMATCHED, amountCents: { gt: 0 } },
    });

    return {
      periodCreditCents: creditSum._sum.amountCents ?? 0,
      unmatchedCount,
      transactions: rows.map(serializeTx),
    };
  });

  app.post("/api/bank/sync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = z
      .object({ force: z.boolean().optional() })
      .safeParse(request.body ?? {});
    try {
      const result = await importTransactions({
        force: body.success ? body.data.force !== false : true,
      });
      return result;
    } catch (e) {
      return reply.code(502).send({
        error: e instanceof Error ? e.message : "Sync Revolut échouée",
      });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/bank/transactions/:id/suggestions",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const tx = await prisma.bankTransaction.findUnique({
        where: { id: request.params.id },
      });
      if (!tx) return reply.code(404).send({ error: "Introuvable" });
      const suggestions = await buildSuggestionsForTx({
        amountCents: tx.amountCents,
        reference: tx.reference,
        counterpartyName: tx.counterpartyName,
      });
      return { suggestions };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/bank/transactions/:id/match",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = z
        .object({
          invoiceId: z.string().min(1),
          allowPartial: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      try {
        const result = await applyInvoiceMatch({
          bankTxId: request.params.id,
          invoiceId: parsed.data.invoiceId,
          allowPartial: parsed.data.allowPartial === true,
        });
        return result;
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Rapprochement impossible" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/bank/transactions/:id/orphan-payment",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = z
        .object({ notes: z.string().optional().nullable() })
        .safeParse(request.body ?? {});
      try {
        return await applyOrphanPayment({
          bankTxId: request.params.id,
          notes: parsed.success ? parsed.data.notes : null,
        });
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Encaissement impossible" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/bank/transactions/:id/ignore",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = z
        .object({
          category: z.nativeEnum(BankIgnoreCategory),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Catégorie invalide" });
      }
      try {
        await ignoreBankTransaction({
          bankTxId: request.params.id,
          category: parsed.data.category,
        });
        return { ok: true };
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Ignore impossible" });
      }
    },
  );

  app.get("/api/bank/sync-logs", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const rows = await prisma.bankSyncLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      imported: r.imported,
      updated: r.updated,
      matchedAuto: r.matchedAuto,
      unmatched: r.unmatched,
      errorMessage: r.errorMessage,
    }));
  });

  /** Simulation DEV : crée un virement entrant local (sans Revolut). */
  app.post("/api/bank/simulate", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (process.env.NODE_ENV === "production") {
      return reply.code(403).send({ error: "Simulation réservée au développement" });
    }
    const schema = z.object({
      amountEuros: z.coerce.number().positive().max(1_000_000),
      counterpartyName: z.string().min(1).max(120).optional(),
      reference: z.string().max(200).optional().nullable(),
      bookedAt: z.string().optional(),
      /** Rapprochement direct sur une facture (DEV). */
      invoiceId: z.string().min(1).optional(),
      /** Si aucun rapprochement auto : créer un encaissement sans facture (DEV). */
      orphanIfUnmatched: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const amountCents = Math.round(parsed.data.amountEuros * 100);
    const bookedAt = parsed.data.bookedAt
      ? new Date(parsed.data.bookedAt)
      : new Date();
    const revolutId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const suggestions = await buildSuggestionsForTx({
      amountCents,
      counterpartyName: parsed.data.counterpartyName ?? "Client simulation",
      reference: parsed.data.reference ?? null,
    }).catch(() => []);

    const row = await prisma.bankTransaction.create({
      data: {
        revolutId,
        bookedAt,
        amountCents,
        currency: "EUR",
        counterpartyName: parsed.data.counterpartyName ?? "Client simulation",
        reference: parsed.data.reference ?? `SIM-${new Date().toISOString().slice(0, 10)}`,
        revolutState: "completed",
        status: BankTxStatus.UNMATCHED,
        suggestionsJson: suggestions.length ? JSON.stringify(suggestions) : null,
      },
    });

    let autoMatched = false;
    let paymentId: string | null = null;
    let matchMode: "invoice" | "orphan" | null = null;

    try {
      if (parsed.data.invoiceId) {
        const matched = await applyInvoiceMatch({
          bankTxId: row.id,
          invoiceId: parsed.data.invoiceId,
          allowPartial: true,
        });
        autoMatched = true;
        paymentId = matched.paymentId;
        matchMode = "invoice";
      } else {
        const decision = await decideAutoMatch({
          amountCents,
          reference: parsed.data.reference ?? row.reference,
          counterpartyName: row.counterpartyName,
        });
        if (decision.kind === "matched") {
          const matched = await applyInvoiceMatch({
            bankTxId: row.id,
            invoiceId: decision.invoiceId,
          });
          autoMatched = true;
          paymentId = matched.paymentId;
          matchMode = "invoice";
        } else if (parsed.data.orphanIfUnmatched) {
          const matched = await applyOrphanPayment({
            bankTxId: row.id,
            notes: "Simulation DEV : encaissement sans facture",
          });
          autoMatched = true;
          paymentId = matched.paymentId;
          matchMode = "orphan";
        }
      }
    } catch {
      // La transaction reste UNMATCHED pour rapprochement manuel.
    }

    const final = await prisma.bankTransaction.findUnique({
      where: { id: row.id },
      include: { matchedInvoice: { select: { id: true, number: true } } },
    });

    await prisma.bankSyncLog.create({
      data: {
        startedAt: new Date(),
        finishedAt: new Date(),
        imported: 1,
        updated: autoMatched ? 1 : 0,
        matchedAuto: autoMatched ? 1 : 0,
        unmatched: autoMatched ? 0 : 1,
        errorMessage: null,
      },
    });

    return {
      ...serializeTx(final!),
      autoMatched,
      paymentId,
      matchMode,
    };
  });
};
