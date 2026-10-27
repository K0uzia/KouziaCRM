import { BlockList, isIP } from "node:net";
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

/**
 * Adresses d'écoute admises : réseau local privé (RFC 1918, IPv6 ULA fc00::/7) ou boucle locale. Liste d'autorisation
 * plutôt que refus de 0.0.0.0 : les écritures de l'adresse non spécifiée (::, [::0.0.0.0], [::ffff:0:0]…) et toute
 * adresse publique sont refusées d'office.
 */
const LISTEN_ALLOWED = (() => {
  const list = new BlockList();
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addAddress("::1", "ipv6");
  return list;
})();

/** IPv4 écrite en IPv6 (::ffff:a.b.c.d, ::ffff:hhhh:hhhh, ::a.b.c.d) ramenée à sa forme IPv4. */
function normalizeHost(host: string): { addr: string; type: "ipv4" | "ipv6" } {
  if (isIP(host) === 4) return { addr: host, type: "ipv4" };
  const lower = host.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower.replace(/^::/, "0:"));
  if (dotted && isIP(dotted[1]!) === 4) return { addr: dotted[1]!, type: "ipv4" };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const a = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return { addr: [a >> 8, a & 255, b >> 8, b & 255].join("."), type: "ipv4" };
  }
  return { addr: host, type: "ipv6" };
}

/** HUB_LISTEN : "IP:port" ou "[IPv6]:port", IP privée explicite (jamais toutes les interfaces ni une adresse publique). */
export function parseHubListen(raw: string): { host: string; port: number } {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):(\d{1,5})$/.exec(raw.trim());
  const host = m?.[1] ?? m?.[2] ?? "";
  const port = Number(m?.[3]);
  if (!m || isIP(host) === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HUB_LISTEN : valeur invalide « ${raw} » (attendu : IP du CT sur le réseau local et port, ex. 192.168.1.20:3100)`);
  }
  const { addr, type } = normalizeHost(host);
  if (!LISTEN_ALLOWED.check(addr, type)) {
    throw new Error(`HUB_LISTEN : « ${host} » refusée, donner l'IP privée du CT sur le réseau local (ex. 192.168.1.20 ; jamais 0.0.0.0, :: ni une adresse publique)`);
  }
  return { host, port };
}

/** Longueur minimale du secret partagé avec le hub (openssl rand -hex 32 en donne 64). */
export const HUB_SECRET_MIN = 32;

/** Configuration lue dans l'environnement, ou null (aucun écouteur) si une des deux variables manque. */
export function getHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig | null {
  const secret = env.HUB_READ_SECRET?.trim();
  const listen = env.HUB_LISTEN?.trim();
  if (!secret || !listen) return null;
  if (secret.length < HUB_SECRET_MIN) {
    throw new Error(`HUB_READ_SECRET trop court (${secret.length} caractères, ${HUB_SECRET_MIN} au moins) : générer « openssl rand -hex 32 »`);
  }
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
