import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { readSiteMedia } from "@/lib/site/media.js";
import { projectOut } from "@/lib/site/mapping.js";
import { buildPreview, previewMediaShas, signPreviewToken, verifyPreviewToken } from "@/lib/site/preview.js";

/** Même réponse pour un jeton absent, faux, expiré ou une réalisation supprimée : rien n'est révélé. */
const NOT_FOUND = { error: "Introuvable" };
const idParams = z.object({ id: z.string().min(1).max(64) });

/** Origine de la page /apercu : le site (PUBLIC_WEB_ORIGIN), null si elle n'est pas configurée. */
export function previewWebOrigin(): string | null {
  return process.env.PUBLIC_WEB_ORIGIN?.trim().replace(/\/+$/, "") || null;
}

/**
 * Origines admises par le CORS de l'aperçu : la page /apercu du site ; le site local (Astro, port 4321) seulement hors
 * production (audit du site, 27/10/2026 : localhost était admis en production).
 */
export function previewCorsOrigins(): string[] {
  const site = previewWebOrigin();
  const local = process.env.NODE_ENV === "production" ? [] : ["http://localhost:4321", "http://127.0.0.1:4321"];
  return [...(site ? [site] : []), ...local];
}

const noTrace = (reply: FastifyReply) => reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow").header("Referrer-Policy", "no-referrer");

/**
 * Aperçu du brouillon d'une réalisation (lot 5b) : lien signé émis par l'admin, lu par la page /apercu du site.
 * Journaux : id de la réalisation et résultat, jamais le jeton (en-tête masqué, paramètre ?jeton= masqué).
 */
export const sitePreviewRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/site/projects/:id/preview", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Données invalides" });
    const project = await prisma.siteProject.findUnique({ where: { id: params.data.id }, select: { id: true } });
    if (!project) return reply.code(404).send({ error: "Réalisation introuvable" });
    const origin = previewWebOrigin();
    if (!origin) return reply.code(503).send({ error: "Adresse du site (PUBLIC_WEB_ORIGIN) non configurée : aperçu impossible." });
    const { token, expiresAt } = signPreviewToken(project.id);
    request.log.info({ projectId: project.id, result: "lien-emis" }, "aperçu du brouillon");
    // Jeton dans le fragment : jamais envoyé au serveur du site ni gardé dans ses journaux.
    return { url: `${origin}/apercu/#jeton=${token}`, expiresAt: expiresAt.toISOString() };
  });

  app.get(
    "/api/public/preview/realisation",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      noTrace(reply);
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
      const claim = verifyPreviewToken(token);
      const preview = claim && token ? await buildPreview(claim.projectId, token, claim.expiresAt) : null;
      request.log.info({ projectId: claim?.projectId ?? null, result: preview ? "lu" : "refuse" }, "aperçu du brouillon");
      if (!preview) return reply.code(404).send(NOT_FOUND);
      return preview;
    },
  );

  // Images de l'aperçu : jeton en paramètre (une balise img n'envoie pas d'en-tête), seulement celles de CETTE réalisation.
  app.get(
    "/api/public/preview/media/:file",
    { config: { rateLimit: { max: 300, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      noTrace(reply).header("Cache-Control", "private, no-store").header("Cross-Origin-Resource-Policy", "cross-origin");
      const claim = verifyPreviewToken((request.query as { jeton?: string }).jeton);
      const m = /^([a-f0-9]{12})(-2x)?\.webp$/.exec((request.params as { file: string }).file);
      const project = claim && m ? await prisma.siteProject.findUnique({ where: { id: claim.projectId } }) : null;
      const cited = Boolean(project && m && previewMediaShas(projectOut(project, { preview: true })).includes(m[1]!));
      const buf = cited && m ? await readSiteMedia(m[1]!, Boolean(m[2])) : null;
      if (!buf) {
        request.log.info({ projectId: claim?.projectId ?? null, result: "refuse" }, "image de l'aperçu");
        return reply.code(404).send(NOT_FOUND);
      }
      return reply.type("image/webp").send(buf);
    },
  );
};
