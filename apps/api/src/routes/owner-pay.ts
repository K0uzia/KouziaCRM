import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { getOwnerPaySummary } from "@/lib/finance/owner-pay.js";

const withdrawalSchema = z.object({
  amountCents: z.number().int().min(1, "Montant supérieur à 0 attendu").max(100_000_000, "Montant trop élevé"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue (AAAA-MM-JJ)"),
  note: z.string().trim().max(200, "200 caractères au plus").optional().nullable(),
});

/** Midi local : la date reste dans le bon mois quel que soit le fuseau. */
function localNoon(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

const eur = (cents: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100).replace(/[  ]/g, " ");

/** Un retrait ne peut pas dépasser le salaire disponible (le cumul afficherait 0 € et masquerait l'écart). */
function overAvailable(amountCents: number, availableCents: number) {
  return amountCents > availableCents
    ? { error: { formErrors: [], fieldErrors: { amountCents: [`Au plus ${eur(availableCents)} disponibles`] } } }
    : null;
}

/** Salaire disponible (cumul) et retraits de l'entrepreneur (virements pro vers perso, saisis à la main). */
export const ownerPayRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/owner-pay", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    // Appels l'un après l'autre : une erreur dans le second ne laisse pas le premier rejeté sans gestionnaire.
    const summary = await getOwnerPaySummary();
    const withdrawals = await prisma.ownerWithdrawal.findMany({ orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 50 });
    return { ...summary, withdrawals };
  });

  app.post("/api/owner-withdrawals", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = withdrawalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const over = overAvailable(parsed.data.amountCents, (await getOwnerPaySummary()).availableCents);
    if (over) return reply.code(400).send(over);
    const created = await prisma.ownerWithdrawal.create({
      data: {
        amountCents: parsed.data.amountCents,
        date: localNoon(parsed.data.date),
        note: parsed.data.note || null,
        createdByEmail: (request as { user?: { email?: string } }).user?.email ?? null,
      },
    });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string } }>("/api/owner-withdrawals/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = withdrawalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const current = await prisma.ownerWithdrawal.findUnique({ where: { id: request.params.id } });
    if (!current) return reply.code(404).send({ error: "Retrait introuvable" });
    // Correction : le montant actuel du retrait redevient disponible.
    const over = overAvailable(parsed.data.amountCents, (await getOwnerPaySummary()).availableCents + current.amountCents);
    if (over) return reply.code(400).send(over);
    const updated = await prisma.ownerWithdrawal.updateMany({
      where: { id: request.params.id },
      data: { amountCents: parsed.data.amountCents, date: localNoon(parsed.data.date), note: parsed.data.note || null },
    });
    if (updated.count === 0) return reply.code(404).send({ error: "Retrait introuvable" });
    return prisma.ownerWithdrawal.findUnique({ where: { id: request.params.id } });
  });

  app.delete<{ Params: { id: string } }>("/api/owner-withdrawals/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const removed = await prisma.ownerWithdrawal.deleteMany({ where: { id: request.params.id } });
    if (removed.count === 0) return reply.code(404).send({ error: "Retrait introuvable" });
    return { ok: true };
  });
};
