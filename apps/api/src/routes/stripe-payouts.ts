import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { createManualPayout, getPayoutPreview, PayoutError } from "@/lib/stripe/payouts.js";
import { StripeConfigError } from "@/lib/stripe/client.js";

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

    const payouts = await prisma.stripePayout.findMany({
      orderBy: [{ arrivalDate: "desc" }, { createdAt: "desc" }],
      take: 100,
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
    const pending = await prisma.payment.findMany({
      where: { stripePaymentIntentId: { not: null }, stripePayoutId: null, amountCents: { gt: 0 } },
      orderBy: { paidAt: "desc" },
      take: 100,
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
      pending: {
        grossCents: pending.reduce((s, x) => s + x.amountCents, 0),
        feeCents: pending.reduce((s, x) => s + (x.feeCents ?? 0), 0),
        payments: pending,
      },
    };
  });
};
