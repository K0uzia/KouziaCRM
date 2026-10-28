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
  scheduleSubscriptionEnd,
  cancelScheduledEnd,
  computeMrrCents,
  generateDueSubscriptionInvoices,
  createSubscriptionRevision,
  SubscriptionError,
  SubscriptionLockedError,
  deleteSubscription,
  assertAmountCorrectable,
} from "@/lib/subscriptions/subscription-service.js";
import { buyoutStateOf, BuyoutError, createBuyoutQuote, setTransferredAt } from "@/lib/subscriptions/buyout.js";

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
  /** Début dans le passé : facturer chaque période passée (rattrapage voulu). Défaut : 1re échéance à partir d'aujourd'hui. */
  catchUpPastPeriods: z.boolean().optional(),
  /** Durée d'engagement en mois : pas d'abonnement sans engagement (décision du 23/10/2026), 12 mois par défaut. */
  commitmentMonths: z.union([z.literal(12), z.literal(24), z.literal(36)], { message: "Engagement : 12, 24 ou 36 mois." }).default(12),
});

const patchSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  /** Correction du montant : seulement un contrat créé à la main, jamais facturé, sans Stripe (sinon 409). */
  amountEuros: z.coerce.number().min(0.01).optional(),
  billingDay: z.number().int().min(1).max(28).optional(),
  endDate: z.string().optional().nullable(),
  firstInvoiceAt: z.string().min(1).optional(),
});

function toCents(euros: number): number {
  return Math.round(euros * 100);
}

/**
 * Date saisie « AAAA-MM-JJ » : minuit à Paris (audit du 27/10/2026). new Date("2026-12-01") donnait 1 h du matin, d'où
 * une 1re échéance repoussée d'une période quand le jour de départ égale le jour de prélèvement.
 */
function parseDate(value: string | undefined | null): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
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
        startDate: parseDate(parsed.data.startDate) ?? new Date(),
        endDate: parseDate(parsed.data.endDate),
        firstInvoiceAt: parseDate(parsed.data.firstInvoiceAt) ?? undefined,
        collectionMethod: parsed.data.collectionMethod,
        commitmentMonths: parsed.data.commitmentMonths ?? null,
        catchUpPastPeriods: parsed.data.catchUpPastPeriods ?? false,
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
    // Rachat (R1) : null si l'offre n'a pas de prestation de rachat.
    return { ...sub, buyout: await buyoutStateOf(sub.id) };
  });

  // Proposer le rachat (R1) : devis brouillon en paiement unique, modifiable avant émission ; 409 si un devis est en cours.
  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/buyout-quote", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const exists = await prisma.subscription.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: "Introuvable" });
    try {
      return reply.code(201).send(await createBuyoutQuote(exists.id));
    } catch (err) {
      if (err instanceof BuyoutError) return reply.code(err.statusCode).send({ error: err.message, ...(err.quoteId ? { quoteId: err.quoteId } : {}) });
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      if (parsed.data.amountEuros !== undefined) await assertAmountCorrectable(request.params.id, toCents(parsed.data.amountEuros));
      const sub = await updateSubscription(request.params.id, {
        label: parsed.data.label,
        amountCents: parsed.data.amountEuros === undefined ? undefined : toCents(parsed.data.amountEuros),
        billingDay: parsed.data.billingDay,
        endDate: parseDate(parsed.data.endDate),
        firstInvoiceAt: parseDate(parsed.data.firstInvoiceAt) ?? undefined,
      });
      return sub;
    } catch (err) {
      if (err instanceof SubscriptionLockedError) return reply.code(409).send({ error: err.message });
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Supprime un contrat créé par erreur (à la main, jamais facturé, sans Stripe) ; sinon 409 : le clôturer.
  app.delete<{ Params: { id: string } }>("/api/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      await deleteSubscription(request.params.id);
      return { ok: true };
    } catch (err) {
      if (err instanceof SubscriptionLockedError) return reply.code(409).send({ error: err.message });
      if (err instanceof SubscriptionError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  // Suspendre, reprendre, clôturer : sous prélèvement Stripe, l'action est faite d'abord
  // dans Stripe ; si Stripe échoue, l'état ERP ne change pas (502 et message clair).
  // invoiceRemaining (clôture pendant l'engagement, 28/10/2026) : facturer d'abord les échéances restantes.
  const endSchema = z.object({ endDate: z.string().date().optional(), invoiceRemaining: z.boolean().optional() }).nullable().optional();
  for (const kind of ["pause", "resume", "end", "schedule-end", "cancel-scheduled-end"] as const) {
    app.post<{ Params: { id: string } }>(`/api/subscriptions/:id/${kind}`, async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = endSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      const id = request.params.id;
      try {
        if (kind === "pause") return await pauseSubscription(id);
        if (kind === "resume") return await resumeSubscription(id);
        if (kind === "schedule-end") return await scheduleSubscriptionEnd(id);
        if (kind === "cancel-scheduled-end") return await cancelScheduledEnd(id);
        return await endSubscription(id, parsed.data?.endDate ? new Date(parsed.data.endDate) : undefined, { invoiceRemaining: parsed.data?.invoiceRemaining });
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
      billingInterval: z.enum(["MONTH", "QUARTER", "YEAR"]).optional(),
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

  // Transfert du site effectué (R2), suivi seulement : date du jour par défaut, null pour la retirer ; 409 sans rachat signé.
  const transferSchema = z.object({ transferredAt: z.iso.date().nullable() });
  app.put<{ Params: { id: string } }>("/api/subscriptions/:id/transfer", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Date de transfert invalide" });
    const exists = await prisma.subscription.findUnique({ where: { id: request.params.id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: "Introuvable" });
    try {
      return await setTransferredAt(exists.id, parsed.data.transferredAt ? new Date(`${parsed.data.transferredAt}T12:00:00`) : null);
    } catch (err) {
      if (err instanceof BuyoutError) return reply.code(err.statusCode).send({ error: err.message });
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
