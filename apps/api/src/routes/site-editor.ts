import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { GithubError, readSiteRepoFiles } from "@/lib/site/github.js";
import { sitePublicUrl } from "@/lib/site/publish.js";
import { EditorValidationError, editorPayload, forgetSiteContract, isEditorDocId, readSiteContract, writeEditorDoc } from "@/lib/site/editor.js";
import { applyResync, resyncPlan, ResyncStaleError, type PublishedDocs } from "@/lib/site/resync.js";
import type { SiteContract } from "@/lib/site/editeur-rules.js";

const body = z.strictObject({ value: z.record(z.string(), z.unknown()) });
const contractError = (e: unknown) => (e instanceof GithubError ? e.message : "Contrat du site illisible.");
const applyBody = z.strictObject({ planId: z.string().regex(/^[0-9a-f]{16}$/) });

/** Contenu publié et contrat, lus sur la branche du site comme pour la publication (fichier illisible : erreur). */
async function publishedSite(): Promise<{ contract: SiteContract; published: PublishedDocs }> {
  const { files, optional, contract } = await readSiteRepoFiles();
  const json = (raw: string | undefined) => (raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>));
  return {
    contract: contract as SiteContract,
    published: { infos: json(files.infos), textes: json(files.textes), pages: json(optional.pages), seo: json(optional.seo), menus: json(optional.menus), "espace-client": json(optional["espace-client"]) },
  };
}

/** « Tous les textes » : éditeur généré depuis le contrat du site (lot générique L1). */
export const siteEditorRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/site/editor", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const force = (request.query as { force?: string }).force === "1";
    // « Où ce texte paraît » : site en ligne, et site local en développement (PUBLIC_WEB_ORIGIN sur localhost).
    const local = process.env.PUBLIC_WEB_ORIGIN?.trim().replace(/\/$/, "");
    const siteUrls = { online: sitePublicUrl(), local: local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(local) ? local : null };
    try {
      return { available: true, siteUrls, ...(await editorPayload(await readSiteContract(force))) };
    } catch (e) {
      return { available: false, error: contractError(e) };
    }
  });

  // « Resynchroniser depuis le site » : plan (champs vides remplis, champs retirés du site), puis application confirmée.
  app.get("/api/site/editor/resync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const { contract, published } = await publishedSite();
      return (await resyncPlan(contract, published)).plan;
    } catch (e) {
      return reply.code(503).send({ error: contractError(e) });
    }
  });

  app.post("/api/site/editor/resync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = applyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Plan invalide" });
    let site;
    try {
      site = await publishedSite();
    } catch (e) {
      return reply.code(503).send({ error: contractError(e) });
    }
    try {
      const plan = await applyResync(site.contract, site.published, parsed.data.planId);
      forgetSiteContract();
      return plan;
    } catch (e) {
      if (e instanceof ResyncStaleError) return reply.code(409).send({ error: e.message });
      if (e instanceof EditorValidationError) return reply.code(400).send({ error: e.message, issues: e.issues });
      throw e;
    }
  });

  app.put("/api/site/editor/:doc", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const { doc } = request.params as { doc: string };
    if (!isEditorDocId(doc)) return reply.code(404).send({ error: "Document inconnu" });
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Données invalides", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    let contract;
    try {
      contract = await readSiteContract();
    } catch (e) {
      return reply.code(503).send({ error: contractError(e) });
    }
    try {
      return { value: await writeEditorDoc(doc, parsed.data.value, contract) };
    } catch (e) {
      if (e instanceof EditorValidationError) return reply.code(400).send({ error: e.message, issues: e.issues });
      throw e;
    }
  });
};
