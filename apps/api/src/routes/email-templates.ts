import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { REVIEW_FAMILIES } from "@/lib/email/review.js";
import { TEMPLATE_REGISTRY, templateDefinition, validateTemplate, type TemplateDefinition } from "@/lib/email/template-registry.js";
import { previewTemplate } from "@/lib/email/templates.js";
import { PreviewSourceError, previewSources, previewWithSource } from "@/lib/email/template-preview.js";

const keyParams = z.object({ key: z.string().min(1).max(64) });
// Retours chariot normalisés : le modèle d'origine et le texte enregistré se comparent ligne à ligne.
const text = (max: number) => z.string().max(max).transform((s) => s.replace(/\r\n?/g, "\n"));
const templateBody = z.strictObject({ subject: text(300), body: text(20_000) });
const previewBody = templateBody.extend({ sourceId: z.string().min(1).max(64).optional() });

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: error.issues[0]?.message ?? "Données invalides", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

const familyLabel = (def: TemplateDefinition) => def.section ?? (def.family ? REVIEW_FAMILIES[def.family] : null);

async function templateView(def: TemplateDefinition) {
  const row = def.locked ? null : await prisma.emailTemplate.findUnique({ where: { key: def.key } });
  return {
    key: def.key,
    label: def.label,
    family: def.family,
    familyLabel: familyLabel(def),
    recipient: def.recipient,
    locked: def.locked ?? null,
    variables: def.variables,
    required: def.required,
    original: { subject: def.subject, body: def.body },
    current: { subject: row?.subject ?? def.subject, body: row?.body ?? def.body },
    modified: row != null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * Modèles d'e-mails (M2) : la base ne garde que les modifications ; enregistrer le texte d'origine ou « Revenir au texte
 * d'origine » supprime la ligne, et l'e-mail repart du code. Un modèle verrouillé n'est jamais modifiable (409).
 */
export const emailTemplatesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return reply;
  });

  const resolve = (request: { params: unknown }, reply: FastifyReply) => {
    const params = keyParams.safeParse(request.params);
    const def = params.success ? templateDefinition(params.data.key) : null;
    if (!def) {
      void reply.code(404).send({ error: "Modèle introuvable" });
      return null;
    }
    return def;
  };

  app.get("/api/email-templates", async () => {
    const rows = await prisma.emailTemplate.findMany({ select: { key: true, updatedAt: true } });
    const byKey = new Map(rows.map((r) => [r.key, r.updatedAt]));
    return {
      templates: TEMPLATE_REGISTRY.map((def) => {
        const updatedAt = def.locked ? undefined : byKey.get(def.key);
        return {
          key: def.key,
          label: def.label,
          family: def.family,
          familyLabel: familyLabel(def),
          recipient: def.recipient,
          locked: def.locked ?? null,
          subject: def.subject,
          modified: updatedAt != null,
          updatedAt: updatedAt?.toISOString() ?? null,
        };
      }),
    };
  });

  app.get("/api/email-templates/:key", async (request, reply) => {
    const def = resolve(request, reply);
    if (!def) return reply;
    return templateView(def);
  });

  app.put("/api/email-templates/:key", async (request, reply) => {
    const def = resolve(request, reply);
    if (!def) return reply;
    if (def.locked) return reply.code(409).send({ error: def.locked });
    const body = templateBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const { subject, body: content } = body.data;
    const issues = validateTemplate(def.key, subject, content);
    if (issues.length) return reply.code(400).send({ error: issues[0]!.message, templateIssues: issues });
    if (subject === def.subject && content === def.body) {
      await prisma.emailTemplate.deleteMany({ where: { key: def.key } });
    } else {
      await prisma.emailTemplate.upsert({ where: { key: def.key }, create: { key: def.key, subject, body: content }, update: { subject, body: content } });
    }
    return templateView(def);
  });

  app.delete("/api/email-templates/:key", async (request, reply) => {
    const def = resolve(request, reply);
    if (!def) return reply;
    if (def.locked) return reply.code(409).send({ error: def.locked });
    await prisma.emailTemplate.deleteMany({ where: { key: def.key } });
    return templateView(def);
  });

  app.post("/api/email-templates/:key/preview", async (request, reply) => {
    const def = resolve(request, reply);
    if (!def) return reply;
    const body = previewBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const { subject, body: content, sourceId } = body.data;
    let preview;
    try {
      // Donnée réelle choisie : valeurs calculées comme à l'envoi, rien n'est envoyé ni enregistré (M3c).
      preview = sourceId ? await previewWithSource(def.key, { subject, body: content }, sourceId) : await previewTemplate(def.key, subject, content);
    } catch (err) {
      if (err instanceof PreviewSourceError) return reply.code(404).send({ error: err.message });
      throw err;
    }
    return { ...preview, templateIssues: def.locked ? [] : validateTemplate(def.key, subject, content) };
  });

  app.get("/api/email-templates/:key/sources", async (request, reply) => {
    const def = resolve(request, reply);
    if (!def) return reply;
    return { sources: await previewSources(def.key) };
  });
};
