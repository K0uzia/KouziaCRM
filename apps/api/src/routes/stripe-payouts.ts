import { LIST_CAP } from "@/lib/list-cap.js";
import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { createManualPayout, getPayoutPreview, PayoutError } from "@/lib/stripe/payouts.js";
import { StripeConfigError } from "@/lib/stripe/client.js";
import { getStripeFlux } from "@/lib/finance/stripe-flux.js";

const payoutSchema = z.object({
  amountCents: z.number().int().positive(),
  /** Identifiant tiré à l'ouverture de la fenêtre : clé d'idempotence côté Stripe. */
  requestId: z.string().uuid(),
});

function payoutFailure(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) {
  if (e instanceof PayoutError || e instanceof StripeConfigError) {
    return reply.code(e.statusCode).send({ error: e.message });
  }
  throw e;
}

/**
 * Versements Stripe vers le compte bancaire, en lecture seule : le vrai rapprochement entre
 * les encaissements Stripe et la banque (remplace le rapprochement Revolut Business).
 */
export const stripePayoutsRoutes: FastifyPluginAsync = async (app) => {
  // Flux Stripe : rapprochement du mois (encaissé, frais, versé, en attente, retenues) et des versements.
  app.get("/api/stripe/flux", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z
      .object({ month: z.string().regex(/^\d{4}-\d{2}$/,"Mois attendu (AAAA-MM)").optional() })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return getStripeFlux(parsed.data.month);
  });

  // Fenêtre « Verser » : solde disponible, compte de destination, délai.
  app.get("/api/stripe/payouts/preview", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      return await getPayoutPreview();
    } catch (e) {
      return payoutFailure(reply, e);
    }
  });

  // Versement manuel du solde Stripe vers le compte bancaire (bouton « Verser »).
  app.post(
    "/api/stripe/payouts",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = payoutSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Montant ou requête invalide." });
      try {
        const result = await createManualPayout({ ...parsed.data, actorEmail: request.user?.email ?? null });
        request.log.info(
          { event: "stripe_payout_requested", payoutId: result.stripePayoutId, amountCents: result.amountCents, by: request.user?.email },
          "versement Stripe demandé",
        );
        return result;
      } catch (e) {
        return payoutFailure(reply, e);
      }
    },
  );

  app.get("/api/stripe/payouts", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    // Listes complètes (plus de limite silencieuse à 100) ; les sommes en attente sont agrégées sur tout le reste.
    const payoutsTotal = await prisma.stripePayout.count();
    const payouts = await prisma.stripePayout.findMany({
      orderBy: [{ arrivalDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: LIST_CAP,
      include: {
        payments: {
          orderBy: { paidAt: "asc" },
          select: {
            id: true,
            amountCents: true,
            feeCents: true,
            paidAt: true,
            method: true,
            invoice: { select: { id: true, number: true, client: { select: { displayName: true } } } },
          },
        },
      },
    });

    // Encaissements Stripe pas encore versés sur le compte (en attente du prochain versement).
    const pendingWhere = { stripePaymentIntentId: { not: null }, stripePayoutId: null, amountCents: { gt: 0 } };
    const pendingSum = await prisma.payment.aggregate({ where: pendingWhere, _sum: { amountCents: true, feeCents: true }, _count: { _all: true } });
    const pending = await prisma.payment.findMany({
      where: pendingWhere,
      orderBy: { paidAt: "desc" },
      take: LIST_CAP,
      select: {
        id: true,
        amountCents: true,
        feeCents: true,
        paidAt: true,
        method: true,
        invoice: { select: { id: true, number: true, client: { select: { displayName: true } } } },
      },
    });

    return {
      payouts: payouts.map((p) => {
        const grossCents = p.payments.reduce((s, x) => s + x.amountCents, 0);
        const feeCents = p.payments.reduce((s, x) => s + (x.feeCents ?? 0), 0);
        return {
          id: p.id,
          stripePayoutId: p.stripePayoutId,
          amountCents: p.amountCents,
          arrivalDate: p.arrivalDate,
          status: p.status,
          grossCents,
          feeCents,
          payments: p.payments,
        };
      }),
      payoutsTotal,
      payoutsTruncated: payoutsTotal > payouts.length,
      pending: {
        grossCents: pendingSum._sum.amountCents ?? 0,
        feeCents: pendingSum._sum.feeCents ?? 0,
        count: pendingSum._count._all,
        payments: pending,
      },
    };
  });
};
