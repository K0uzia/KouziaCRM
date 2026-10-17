import { isIP, type BlockList } from "node:net";
import Fastify, { LogController, type FastifyError, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { parseIpList, registerClientIpHook } from "@/lib/client-ip.js";
import { hubRoutes, NOT_FOUND } from "@/routes/hub.js";

/**
 * Écouteur dédié à la lecture par le hub Kouzia : seconde instance Fastify, dans le même processus,
 * liée à l'IP du CT sur le réseau local (HUB_LISTEN). Elle ne sert que /api/hub/*, sans cookie,
 * session, SPA ni CORS. Aucun proxy de confiance : request.ip est l'adresse du socket.
 * Les routes du hub n'existent pas sur l'app principale, donc ni par le tunnel ni sur API_PORT.
 */
export type HubConfig = { secret: string; allowedIps: BlockList; host: string; port: number };

/** HUB_LISTEN : "IP:port" ou "[IPv6]:port", IP explicite (jamais toutes les interfaces). */
export function parseHubListen(raw: string): { host: string; port: number } {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):(\d{1,5})$/.exec(raw.trim());
  const host = m?.[1] ?? m?.[2] ?? "";
  const port = Number(m?.[3]);
  if (!m || isIP(host) === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HUB_LISTEN : valeur invalide « ${raw} » (attendu : IP du CT sur le réseau local et port, ex. 192.168.1.20:3100)`);
  }
  if (host === "0.0.0.0" || /^[0:]+$/.test(host)) {
    throw new Error("HUB_LISTEN : toutes les interfaces refusées, donner l'IP du CT sur le réseau local");
  }
  return { host, port };
}

/** Configuration lue dans l'environnement, ou null (aucun écouteur) si une des deux variables manque. */
export function getHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const secret = env.HUB_READ_SECRET?.trim();
  const listen = env.HUB_LISTEN?.trim();
  if (!secret || !listen) return null;
  const allowedIps = parseIpList((env.HUB_ALLOWED_IPS ?? "").trim().toLowerCase().split(/[,\s]+/), "HUB_ALLOWED_IPS");
  return { secret, allowedIps, ...parseHubListen(listen) };
}

export type BuildHubAppOptions = {
  secret: string;
  allowedIps: BlockList;
  silent?: boolean;
  logStream?: { write(line: string): void };
  now?: () => number;
};

export async function buildHubApp(opts: BuildHubAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Aucun journal de requête : ni en-tête de signature ni corps (noms des clients) écrits.
    logger: opts.silent ? false : opts.logStream ? { stream: opts.logStream } : true,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    exposeHeadRoutes: false,
  });
  registerClientIpHook(app, null);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(404).send(NOT_FOUND);
    request.log.error({ event: "hub_read_error", code: (error as { code?: string }).code }, "lecture du hub en erreur");
    return reply.code(500).send({ error: "Erreur interne" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND));
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });
  await app.register(hubRoutes, { secret: opts.secret, allowedIps: opts.allowedIps, now: opts.now });
  return app;
}

/** Démarre l'écouteur si HUB_READ_SECRET et HUB_LISTEN sont posées ; sinon null, et les routes n'existent pas. */
export async function startHubListener(log: { info(msg: string): void; warn(msg: string): void }): Promise<FastifyInstance | null> {
  const config = getHubConfig();
  if (!config) {
    log.info("[hub] lecture par le hub désactivée (HUB_READ_SECRET et HUB_LISTEN requises)");
    return null;
  }
  if (!process.env.HUB_ALLOWED_IPS?.trim()) log.warn("[hub] HUB_ALLOWED_IPS vide : toute lecture sera refusée");
  const app = await buildHubApp({ secret: config.secret, allowedIps: config.allowedIps });
  await app.listen({ host: config.host, port: config.port });
  log.info(`[hub] lecture par le hub sur ${config.host}:${config.port}`);
  return app;
}
