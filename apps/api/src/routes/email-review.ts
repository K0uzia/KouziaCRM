import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import {
  ALWAYS_REVIEWED,
  REVIEW_FAMILIES,
  REVIEW_FAMILY_IDS,
  ReviewError,
  approveReviewEmail,
  approveReviewEmails,
  countReviewQueue,
  getReviewEmail,
  listReviewQueue,
  parseAutoApprove,
  rejectReviewEmail,
  type ReviewFamily,
} from "@/lib/email/review.js";

const idParams = z.object({ id: z.string().min(1).max(64) });
const editsBody = z.strictObject({ subject: z.string().trim().min(1).max(300).optional(), text: z.string().trim().min(1).max(20_000).optional() });
const bulkBody = z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
const rejectBody = z.strictObject({ reason: z.string().trim().min(1, "Motif obligatoire").max(500) });
// La mise en demeure n'est jamais validée d'office : refusée ici, pas seulement absente de l'écran.
const autoApproveBody = z.strictObject({
  autoApprove: z
    .array(z.enum(REVIEW_FAMILY_IDS as [ReviewFamily, ...ReviewFamily[]]))
    .max(REVIEW_FAMILY_IDS.length)
    .refine((list) => list.every((f) => !ALWAYS_REVIEWED.has(f)), { message: "La mise en demeure est toujours validée à la main." }),
});

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: error.issues[0]?.message ?? "Données invalides", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

const reviewError = (reply: FastifyReply, e: unknown) => {
  if (e instanceof ReviewError) return reply.code(e.status).send({ error: e.message });
  throw e;
};

async function autoApproveView() {
  const settings = await getCompanySettings();
  return {
    autoApprove: parseAutoApprove(settings.emailAutoApproveKinds),
    families: REVIEW_FAMILY_IDS.map((id) => ({ id, label: REVIEW_FAMILIES[id], alwaysReviewed: ALWAYS_REVIEWED.has(id) })),
  };
}

/** File « E-mails à valider » (E6a) : liste, validation (telle quelle ou relue), refus motivé, réglage des familles. */
export const emailReviewRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return reply;
  });

  app.get("/api/emails/review", async () => listReviewQueue());

  app.get("/api/emails/review/count", async () => ({ count: await countReviewQueue() }));

  app.get("/api/emails/review/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    try {
      return await getReviewEmail(params.data.id);
    } catch (e) {
      return reviewError(reply, e);
    }
  });

  app.post("/api/emails/review/:id/approve", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = editsBody.safeParse(request.body ?? {});
    if (!params.success) return invalid(reply, params.error);
    if (!body.success) return invalid(reply, body.error);
    try {
      await approveReviewEmail(params.data.id, body.data);
      return { approved: true };
    } catch (e) {
      return reviewError(reply, e);
    }
  });

  app.post("/api/emails/review/approve", async (request, reply) => {
    const body = bulkBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    return { approved: await approveReviewEmails(body.data.ids) };
  });

  app.post("/api/emails/review/:id/reject", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = rejectBody.safeParse(request.body);
    if (!params.success) return invalid(reply, params.error);
    if (!body.success) return invalid(reply, body.error);
    try {
      await rejectReviewEmail(params.data.id, body.data.reason);
      return { rejected: true };
    } catch (e) {
      return reviewError(reply, e);
    }
  });

  app.get("/api/settings/email-review", async () => autoApproveView());

  app.put("/api/settings/email-review", async (request, reply) => {
    const body = autoApproveBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const settings = await getCompanySettings();
    await prisma.companySettings.update({ where: { id: settings.id }, data: { emailAutoApproveKinds: JSON.stringify([...new Set(body.data.autoApprove)]) } });
    invalidateCompanySettingsCache();
    return autoApproveView();
  });
};
