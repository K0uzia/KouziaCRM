import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";

/**
 * Versements Stripe vers le compte bancaire, en lecture seule : le vrai rapprochement entre
 * les encaissements Stripe et la banque (remplace le rapprochement Revolut Business).
 */
export const stripePayoutsRoutes: FastifyPluginAsync = async (app) => {
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
