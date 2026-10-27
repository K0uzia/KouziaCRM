import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { PromoCode } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { BillingModeError } from "@/lib/quotes/billing-mode.js";
import { assertPromoCodeApplicable, normalizePromoCode, PROMO_CODE_PATTERN, promoCodeUses, promoServiceIds } from "@/lib/quotes/promo-codes.js";

/**
 * Offre > Codes promo (R3) : création, modification (le code lui-même est immuable), désactivation, suppression d'un code
 * jamais utilisé ; codes applicables à un devis (client et offres). Usages calculés à chaque lecture.
 */
const day = z.iso.date().nullable().optional();
const fields = {
  kind: z.enum(["PERCENT", "FIXED"]),
  percent: z.coerce.number().gt(0).lt(100).optional(),
  euros: z.coerce.number().gt(0).optional(),
  months: z.number().int().positive().max(36).nullable().optional(),
  validFrom: day,
  validUntil: day,
  maxUses: z.number().int().positive().nullable().optional(),
  serviceIds: z.array(z.string().min(1).max(64)).max(200).nullable().optional(),
  conditionText: z.string().trim().max(200).nullable().optional(),
  active: z.boolean().optional(),
};
const createBody = z.strictObject({ code: z.string().trim().min(3).max(32), ...fields });
const updateBody = z.strictObject(fields);
const idParams = z.object({ id: z.string().min(1).max(64) });
const availableQuery = z.object({ clientId: z.string().min(1).max(64), serviceIds: z.string().max(4000).optional(), invoiceId: z.string().min(1).max(64).optional() });

const invalid = (reply: FastifyReply, message: string) => reply.code(400).send({ error: message });

function dataOf(d: z.infer<typeof updateBody>) {
  const value = d.kind === "PERCENT" ? Math.round((d.percent ?? 0) * 100) : Math.round((d.euros ?? 0) * 100);
  if (!value) return { error: d.kind === "PERCENT" ? "Pourcentage requis, entre 0 et 100 % (exclus)." : "Montant par échéance requis." } as const;
  const validFrom = d.validFrom ? new Date(`${d.validFrom}T00:00:00`) : null;
  const validUntil = d.validUntil ? new Date(`${d.validUntil}T23:59:59`) : null;
  if (validFrom && validUntil && validUntil < validFrom) return { error: "La fin de validité précède son début." } as const;
  return {
    data: {
      kind: d.kind,
      value,
      months: d.months ?? null,
      validFrom,
      validUntil,
      maxUses: d.maxUses ?? null,
      serviceIds: d.serviceIds?.length ? JSON.stringify(d.serviceIds) : null,
      conditionText: d.conditionText || null,
      ...(d.active !== undefined ? { active: d.active } : {}),
    },
  } as const;
}

/** Code tel que l'écran l'affiche : usages calculés et état. */
async function view(code: PromoCode, now = new Date()) {
  const uses = await promoCodeUses(code.id);
  const state = !code.active
    ? "INACTIVE"
    : code.validUntil && now > code.validUntil
      ? "EXPIRED"
      : code.validFrom && now < code.validFrom
        ? "UPCOMING"
        : code.maxUses !== null && uses >= code.maxUses
          ? "EXHAUSTED"
          : "ACTIVE";
  return { ...code, serviceIds: promoServiceIds(code), uses, state };
}

export const promoCodesRoutes: FastifyPluginAsync = async (app) => {
  // Hook encapsulé dans ce plugin : il ne couvre que ses routes, toutes admin. Pas de test sur request.url (brute,
  // contournable par « /api/%70romo-codes » : faille relevée par l'audit du 27/10/2026).
  app.addHook("preHandler", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return reply;
  });

  app.get("/api/promo-codes", async () => {
    const rows = await prisma.promoCode.findMany({ orderBy: { createdAt: "desc" } });
    return { codes: await Promise.all(rows.map((c) => view(c))) };
  });

  // Codes qu'un devis peut recevoir : actifs, valables aujourd'hui, pour ses offres, avec un usage restant, jamais utilisés
  // par ce client (le devis lui-même mis à part).
  app.get("/api/promo-codes/available", async (request, reply) => {
    const q = availableQuery.safeParse(request.query);
    if (!q.success) return invalid(reply, "Client attendu");
    const serviceIds = (q.data.serviceIds ?? "").split(",").filter(Boolean);
    const out = [];
    for (const code of await prisma.promoCode.findMany({ where: { active: true }, orderBy: { code: "asc" } })) {
      try {
        await assertPromoCodeApplicable(code, { id: q.data.invoiceId, clientId: q.data.clientId, serviceIds });
        out.push({ id: code.id, code: code.code, kind: code.kind, value: code.value, months: code.months, conditionText: code.conditionText });
      } catch (e) {
        if (!(e instanceof BillingModeError)) throw e;
      }
    }
    return { codes: out };
  });

  app.post("/api/promo-codes", async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Données invalides");
    const code = normalizePromoCode(parsed.data.code);
    if (!PROMO_CODE_PATTERN.test(code)) return invalid(reply, "Code : lettres, chiffres et tiret, 3 à 32 caractères.");
    const built = dataOf(parsed.data);
    if ("error" in built) return invalid(reply, built.error!);
    if (await prisma.promoCode.findUnique({ where: { code } })) return reply.code(409).send({ error: `Le code ${code} existe déjà.` });
    return reply.code(201).send(await view(await prisma.promoCode.create({ data: { code, ...built.data } })));
  });

  app.put("/api/promo-codes/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const parsed = updateBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: "Code introuvable" });
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Données invalides");
    const existing = await prisma.promoCode.findUnique({ where: { id: params.data.id } });
    if (!existing) return reply.code(404).send({ error: "Code introuvable" });
    const built = dataOf(parsed.data);
    if ("error" in built) return invalid(reply, built.error!);
    // Un devis émis garde la remise figée à son émission : modifier le code ne le change pas.
    return view(await prisma.promoCode.update({ where: { id: existing.id }, data: built.data }));
  });

  app.delete("/api/promo-codes/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Code introuvable" });
    const existing = await prisma.promoCode.findUnique({ where: { id: params.data.id } });
    if (!existing) return reply.code(404).send({ error: "Code introuvable" });
    const linked = await prisma.invoice.count({ where: { promoCodeId: existing.id } });
    if (linked > 0) return reply.code(409).send({ error: `Code ${existing.code} utilisé sur ${linked} devis : désactivez-le plutôt.` });
    await prisma.promoCode.delete({ where: { id: existing.id } });
    return reply.code(204).send();
  });
};
