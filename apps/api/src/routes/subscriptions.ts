import { MediatorRequiredError } from "@/lib/company/mediator.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SubscriptionStatus } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { StripeSubscriptionSyncError } from "@/lib/stripe/subscription-control.js";
import { StripeModeError } from "@/lib/stripe/mode.js";
import {
  createSubscription,
  listSubscriptions,
  getSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  endSubscription,
  computeMrrCents,
  generateDueSubscriptionInvoices,
  createSubscriptionRevision,
  SubscriptionError,
} from "@/lib/subscriptions/subscription-service.js";

const createSchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().min(1),
  label: z.string().min(1).max(200),
  amountEuros: z.coerce.number().min(0.01),
  billingDay: z.number().int().min(1).max(28),
  billingInterval: z.enum(["MONTH", "YEAR"]).default("MONTH"),
  startDate: z.string().optional(),
  endDate: z.string().optional().nullable(),
  /** 1re facture ou 1er prélèvement différé (ex. une année offerte). Absent : prochain jour de facturation. */
  firstInvoiceAt: z.string().min(1).optional().nullable(),
  /** Virement (facture de l'ERP) ou prélèvement Stripe (carte ou SEPA, lien de mise en place envoyé au client). */
  collectionMethod: z.enum(["MANUAL_TRANSFER", "STRIPE"]).default("MANUAL_TRANSFER"),
});

const patchSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  billingDay: z.number().int().min(1).max(28).optional(),
  endDate: z.string().optional().nullable(),
  firstInvoiceAt: z.string().min(1).optional(),
});

function toCents(euros: number): number {
  return Math.round(euros * 100);
}

function parseDate(value: string | undefined | null): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return new Date(value);
}

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/subscriptions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { status?: string };
    const status = q.status
      ? (Object.values(SubscriptionStatus).find((s) => s === q.status) as SubscriptionStatus | undefined)
      : undefined;
    return listSubscriptions(status);
  });

  app.get("/api/subscriptions/mrr", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return computeMrrCents();
  });

  app.post("/api/subscriptions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const sub = await createSubscription({
        clientId: parsed.data.clientId,
        serviceId: parsed.data.serviceId,
        label: parsed.data.label,
        amountCents: toCents(parsed.data.amountEuros),
        billingDay: parsed.data.billingDay,
        billingInterval: parsed.data.billingInterval,
        startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : new Date(),
        endDate: parseDate(parsed.data.endDate),
        firstInvoiceAt: parseDate(parsed.data.firstInvoiceAt) ?? undefined,
        collectionMethod: parsed.data.collectionMethod,
      });
      // Prélèvement Stripe : le client reçoit le lien de mise en place (mandat SEPA ou carte, 1er prélèvement à la 1re échéance).
      if (sub.collectionMethod === "STRIPE") {
        const { notifyStripeSubscriptionSetup } = await import("@/lib/subscriptions/activate-from-document.js");
        await notifyStripeSubscriptionSetup([sub.id]);
      }
      return reply.code(201).send(sub);
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const sub = await getSubscription(request.params.id);
    if (!sub) return reply.code(404).send({ error: "Introuvable" });
    return sub;
  });

  app.patch<{ Params: { id: string } }>("/api/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const sub = await updateSubscription(request.params.id, {
        label: parsed.data.label,
        amountCents: undefined,
        billingDay: parsed.data.billingDay,
        endDate: parseDate(parsed.data.endDate),
        firstInvoiceAt: parseDate(parsed.data.firstInvoiceAt) ?? undefined,
      });
      return sub;
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Suspendre, reprendre, clôturer : sous prélèvement Stripe, l'action est faite d'abord
  // dans Stripe ; si Stripe échoue, l'état ERP ne change pas (502 et message clair).
  const endSchema = z.object({ endDate: z.string().date().optional() }).nullable().optional();
  for (const kind of ["pause", "resume", "end"] as const) {
    app.post<{ Params: { id: string } }>(`/api/subscriptions/:id/${kind}`, async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = endSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const id = request.params.id;
      try {
        if (kind === "pause") return await pauseSubscription(id);
        if (kind === "resume") return await resumeSubscription(id);
        return await endSubscription(id, parsed.data?.endDate ? new Date(parsed.data.endDate) : undefined);
      } catch (err) {
        if (err instanceof SubscriptionError) return reply.code(400).send({ error: err.message });
        if (err instanceof StripeSubscriptionSyncError) return reply.code(502).send({ error: err.message });
        if (err instanceof StripeModeError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    });
  }

  // Révision légale : émet un devis d'avenant au nouveau montant (envoyé au client).
  // L'abonnement est mis à jour + facture émise à l'acceptation du devis.
  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/revise", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      amountEuros: z.coerce.number().min(0.01),
      label: z.string().min(1).max(200).optional(),
      billingDay: z.number().int().min(1).max(28).optional(),
      billingInterval: z.enum(["MONTH", "YEAR"]).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = await createSubscriptionRevision({
        subscriptionId: request.params.id,
        amountCents: toCents(parsed.data.amountEuros),
        label: parsed.data.label,
        billingDay: parsed.data.billingDay,
        billingInterval: parsed.data.billingInterval,
      });
      return reply.code(201).send(result);
    } catch (err) {
      // Révision envoyée en signature : un particulier exige un médiateur déclaré (L612-1).
      if (err instanceof SubscriptionError || err instanceof MediatorRequiredError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Déclenchement manuel de la génération (utile pour tester sans attendre le cron).
  app.post("/api/subscriptions/run-due", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const generated = await generateDueSubscriptionInvoices();
    return { generated };
  });

  /** Avenants antérieurs aux abonnements multiples, restés sans abonnement : à rattacher par l'admin. */
  app.get("/api/subscriptions/revisions-to-attach", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const { listRevisionsToAttach } = await import("@/lib/subscriptions/activate-from-document.js");
    return listRevisionsToAttach();
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/attach-line", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z.object({ lineId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { attachRevisionLine } = await import("@/lib/subscriptions/activate-from-document.js");
    try {
      await attachRevisionLine(request.params.id, parsed.data.lineId);
      return { ok: true };
    } catch (err) {
      if (err instanceof SubscriptionError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /** Renvoie le lien de mise en place du prélèvement Stripe. */
  app.post<{ Params: { id: string } }>(
    "/api/subscriptions/:id/resend-setup",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const sub = await getSubscription(request.params.id);
      if (!sub) return reply.code(404).send({ error: "Introuvable" });
      if (sub.stripeSubscriptionId) {
        return reply.code(409).send({ error: "Le prélèvement Stripe est déjà actif" });
      }
      const { sendSubscriptionSetupEmail } = await import("@/lib/stripe/billing.js");
      await sendSubscriptionSetupEmail(sub.id);
      await prisma.subscription.update({ where: { id: sub.id }, data: { setupLinkSentAt: new Date() } });
      return { ok: true };
    },
  );
};
