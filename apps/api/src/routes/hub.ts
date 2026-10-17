import { createHmac, timingSafeEqual } from "node:crypto";
import type { BlockList } from "node:net";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isInIpList } from "@/lib/client-ip.js";
import { prisma } from "@/lib/prisma.js";

/**
 * Lecture de l'annuaire des clients par le hub Kouzia (autre CT du Proxmox, réseau local).
 * Montées seulement sur l'écouteur dédié (lib/hub/server.ts), jamais sur l'app principale ni le tunnel.
 * Signature : "sha256=" + HMAC-SHA256 hexadécimal de « horodatage.GET.chemin » avec HUB_READ_SECRET.
 * Tout refus (IP, signature, horodatage, débit) répond la même 404 qu'un client inconnu.
 */
export type HubRoutesOptions = { secret: string; allowedIps: BlockList; now?: () => number };

const WINDOW_S = 5 * 60;
const params = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const SELECT = { id: true, clientNumber: true, displayName: true, type: true } as const;

export const NOT_FOUND = { error: "Not found" };

function validSignature(secret: string, timestamp: string, pathname: string, header: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.GET.${pathname}`).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const hubRoutes: FastifyPluginAsync<HubRoutesOptions> = async (app, opts) => {
  const now = opts.now ?? Date.now;

  /** Motif du refus pour le journal (jamais l'en-tête ni le corps), ou null si la requête est admise. */
  function refusal(request: FastifyRequest): string | null {
    if (request.viaTunnel) return "tunnel";
    if (!isInIpList(opts.allowedIps, request.ip)) return "ip";
    if (request.url.includes("?")) return "query";
    const timestamp = request.headers["x-kouzia-hub-timestamp"];
    const signature = request.headers["x-kouzia-hub-signature"];
    if (typeof timestamp !== "string" || typeof signature !== "string" || !/^\d{1,12}$/.test(timestamp)) return "headers";
    if (!validSignature(opts.secret, timestamp, request.url, signature)) return "signature";
    if (Math.abs(now() / 1000 - Number(timestamp)) > WINDOW_S) return "timestamp";
    return null;
  }

  // preHandler : la limite de débit (onRequest de la route) compte aussi les requêtes refusées.
  app.addHook("preHandler", async (request, reply: FastifyReply) => {
    const reason = refusal(request);
    if (!reason) return;
    request.log.warn({ event: "hub_read_refused", reason }, "lecture du hub refusée");
    return reply.code(404).send(NOT_FOUND);
  });

  const limit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  app.get("/api/hub/clients", { config: limit }, async () => ({
    clients: await prisma.client.findMany({ select: SELECT, orderBy: [{ displayName: "asc" }, { id: "asc" }] }),
  }));

  app.get("/api/hub/clients/:id", { config: limit }, async (request, reply) => {
    const p = params.safeParse(request.params);
    const client = p.success ? await prisma.client.findUnique({ where: { id: p.data.id }, select: SELECT }) : null;
    return client ? { client } : reply.code(404).send(NOT_FOUND);
  });
};
