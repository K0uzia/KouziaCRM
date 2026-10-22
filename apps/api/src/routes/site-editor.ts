import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { GithubError } from "@/lib/site/github.js";
import { EditorValidationError, editorPayload, isEditorDocId, readSiteContract, writeEditorDoc } from "@/lib/site/editor.js";

const body = z.strictObject({ value: z.record(z.string(), z.unknown()) });
const contractError = (e: unknown) => (e instanceof GithubError ? e.message : "Contrat du site illisible.");

/** « Tous les textes » : éditeur généré depuis le contrat du site (lot générique L1). */
export const siteEditorRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/site/editor", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const force = (request.query as { force?: string }).force === "1";
    try {
      return { available: true, ...(await editorPayload(await readSiteContract(force))) };
    } catch (e) {
      return { available: false, error: contractError(e) };
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
