import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import {
  createSalaryPayoutDraft,
  listSalaryPayouts,
  PayoutError,
  upsertPersonalBeneficiary,
} from "@/lib/revolut/payoutService.js";
import { isPayoutEnabled } from "@/lib/revolut/revolutService.js";
import { getScopedCashflow } from "@/lib/finance/cashflow-service.js";
import { prisma } from "@/lib/prisma.js";

export const payoutsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/payouts/status", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const beneficiary = await prisma.revolutBeneficiary.findFirst({
      where: { active: true },
      select: { id: true, label: true },
    });
    const cf = await getScopedCashflow("month");
    return {
      enabled: isPayoutEnabled(),
      resteNetCents: cf.resteNetCents,
      hasBeneficiary: Boolean(beneficiary),
      beneficiaryLabel: beneficiary?.label ?? null,
    };
  });

  app.put("/api/payouts/beneficiary", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z
      .object({
        label: z.string().min(1).max(120),
        name: z.string().min(1).max(200),
        iban: z.string().min(15).max(34),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides" });
    }
    const row = await upsertPersonalBeneficiary(parsed.data);
    return { id: row.id, label: row.label };
  });

  app.get("/api/payouts/salary", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const rows = await listSalaryPayouts();
    return rows.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      currency: r.currency,
      status: r.status,
      revolutDraftId: r.revolutDraftId,
      notes: r.notes,
      beneficiaryLabel: r.beneficiary?.label ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  app.post("/api/payouts/salary", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z
      .object({
        amountCents: z.number().int().positive().optional(),
        notes: z.string().optional().nullable(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides" });
    }
    try {
      const payout = await createSalaryPayoutDraft(parsed.data);
      return reply.code(201).send({
        id: payout.id,
        amountCents: payout.amountCents,
        status: payout.status,
        revolutDraftId: payout.revolutDraftId,
        notes: payout.notes,
        createdAt: payout.createdAt.toISOString(),
      });
    } catch (e) {
      if (e instanceof PayoutError) {
        const code =
          e.code === "DISABLED" || e.code === "NOT_CONFIGURED" ? 403 : 400;
        return reply.code(code).send({ error: e.message, code: e.code });
      }
      return reply.code(502).send({
        error: e instanceof Error ? e.message : "Création brouillon échouée",
      });
    }
  });
};
