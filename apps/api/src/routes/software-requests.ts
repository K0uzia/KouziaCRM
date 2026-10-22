import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import {
  MIN_FILL_MS,
  REQUEST_STATUSES,
  RequestStateError,
  checkFormToken,
  declineSoftwareRequest,
  getSoftwareRequest,
  issueFormToken,
  linkSoftwareRequest,
  serializeListItem,
  submitSchema,
  submitSoftwareRequest,
} from "@/lib/software-requests/service.js";

const listQuery = z.strictObject({ status: z.enum(REQUEST_STATUSES).optional() });
const idParams = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const linkBody = z.strictObject({ clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const NOT_FOUND = { error: "Demande introuvable." };

export const softwareRequestsRoutes: FastifyPluginAsync = async (app) => {
  // Public (site) : jeton du formulaire, horodaté et signé, sans état côté serveur.
  app.get(
    "/api/public/software-requests/token",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async () => ({ token: issueFormToken() }),
  );

  // Public (site) : dépôt d'une demande. Pot de miel et envoi trop rapide : même 201, rien n'est enregistré.
  app.post(
    "/api/public/software-requests",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const parsed = submitSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.info({ event: "software_request_submit", status: 400, reason: "validation" });
        return reply.code(400).send({ code: "validation", error: parsed.error.flatten() });
      }
      if (parsed.data.website?.trim()) {
        request.log.info({ event: "software_request_submit", status: 201, reason: "honeypot" });
        return reply.code(201).send({ ok: true });
      }
      const token = checkFormToken(parsed.data.token);
      if (!token.ok) {
        request.log.info({ event: "software_request_submit", status: 400, reason: "token_invalid" });
        return reply.code(400).send({ code: "token_invalid", error: "Formulaire expiré : rechargez la page." });
      }
      if (token.ageMs < MIN_FILL_MS) {
        request.log.info({ event: "software_request_submit", status: 201, reason: "trop_rapide" });
        return reply.code(201).send({ ok: true });
      }
      const { created } = await submitSoftwareRequest(parsed.data);
      request.log.info({ event: "software_request_submit", status: 201, created });
      return reply.code(201).send({ ok: true });
    },
  );

  // Admin : liste (filtre d'état) et compteurs pour la pastille et les filtres.
  app.get("/api/software-requests", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const [rows, counts] = await Promise.all([
      prisma.softwareRequest.findMany({
        where: query.data.status ? { status: query.data.status } : {},
        orderBy: { createdAt: "desc" },
        include: { client: { select: { id: true, displayName: true } } },
        take: 500,
      }),
      prisma.softwareRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    return {
      items: rows.map(serializeListItem),
      counts: { PENDING: count("PENDING"), CONVERTED: count("CONVERTED"), DECLINED: count("DECLINED") },
    };
  });

  // Pastille de la navigation : nombre de demandes en attente seulement.
  app.get("/api/software-requests/pending-count", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return { pending: await prisma.softwareRequest.count({ where: { status: "PENDING" } }) };
  });

  app.get("/api/software-requests/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    const item = await getSoftwareRequest(params.data.id);
    if (!item) return reply.code(404).send(NOT_FOUND);
    return item;
  });

  // Conversion : rattachement au client créé depuis la fiche (formulaire client prérempli) ou à un client existant.
  app.post("/api/software-requests/:id/link", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const params = idParams.safeParse(request.params);
    const body = linkBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      await linkSoftwareRequest(params.data.id, body.data.clientId);
    } catch (err) {
      if (err instanceof RequestStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return getSoftwareRequest(params.data.id);
  });

  app.post("/api/software-requests/:id/decline", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    try {
      await declineSoftwareRequest(params.data.id);
    } catch (err) {
      if (err instanceof RequestStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    return getSoftwareRequest(params.data.id);
  });
};
