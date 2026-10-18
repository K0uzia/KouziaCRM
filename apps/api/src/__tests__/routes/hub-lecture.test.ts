import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { parseIpList, registerClientIpHook, trustProxyFn } from "@/lib/client-ip.js";
import { buildHubApp, getHubConfig, parseHubListen } from "@/lib/hub/server.js";
import { hubRoutes } from "@/routes/hub.js";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const SECRET = "secret-de-test-du-hub-0123456789";
const HUB_IP = "10.0.0.5";
const allowedIps = parseIpList([HUB_IP], "HUB_ALLOWED_IPS");

function signed(path: string, opts: { secret?: string; signedPath?: string; at?: number } = {}) {
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.GET.${opts.signedPath ?? path}`).digest("hex");
  return { "x-kouzia-hub-timestamp": ts, "x-kouzia-hub-signature": `sha256=${sig}` };
}

const lines: string[] = [];
let hub: FastifyInstance;
let ids: { pro: string; perso: string; asso: string };

beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  const pro = await prisma.client.create({
    data: { type: "B2B", displayName: "Zénith Conseil", companyName: "Zénith Conseil", clientNumber: "CLI-0001", emailEncrypted: "chiffré", notes: "note privée", city: "Lyon" },
  });
  const perso = await prisma.client.create({ data: { type: "B2C", displayName: "Alice Martin", firstName: "Alice", lastName: "Martin" } });
  const asso = await prisma.client.create({ data: { type: "ASSOCIATION", displayName: "Les Amis du Parc", clientNumber: "CLI-0003" } });
  ids = { pro: pro.id, perso: perso.id, asso: asso.id };
  hub = await buildHubApp({ secret: SECRET, allowedIps, logStream: { write: (line) => void lines.push(line) } });
});
afterAll(async () => {
  await hub.close();
  await resetDb();
});

const get = (url: string, headers: Record<string, string> = signed(url), remoteAddress = HUB_IP) =>
  hub.inject({ method: "GET", url, headers, remoteAddress });

describe("lecture des clients par le hub", () => {
  it("liste complète : quatre champs seulement, triée par nom", async () => {
    const res = await get("/api/hub/clients");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      clients: [
        { id: ids.perso, clientNumber: null, displayName: "Alice Martin", type: "B2C" },
        { id: ids.asso, clientNumber: "CLI-0003", displayName: "Les Amis du Parc", type: "ASSOCIATION" },
        { id: ids.pro, clientNumber: "CLI-0001", displayName: "Zénith Conseil", type: "B2B" },
      ],
    });
  });

  it("un client : mêmes champs ; inconnu ou identifiant hors format : 404", async () => {
    const res = await get(`/api/hub/clients/${ids.pro}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ client: { id: ids.pro, clientNumber: "CLI-0001", displayName: "Zénith Conseil", type: "B2B" } });

    const unknown = await get("/api/hub/clients/inconnu_123");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "Not found" });
    const bad = await get("/api/hub/clients/a.b");
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toEqual({ error: "Not found" });
  });

  it("tout refus répond la même 404 qu'un client inconnu", async () => {
    const path = "/api/hub/clients";
    const refused = [
      await get(path, {}),
      await get(path, signed(path, { secret: "autre-secret" })),
      await get(path, signed(path, { signedPath: `${path}/${ids.pro}` })),
      await get(path, signed(path, { at: Date.now() - 6 * 60_000 })),
      await get(path, signed(path, { at: Date.now() + 6 * 60_000 })),
      await get(path, { ...signed(path), "x-kouzia-hub-timestamp": "abc" }),
      await get(path, signed(path), "10.0.0.6"),
      // IP imposée par en-tête : ignorée, aucun proxy de confiance sur cet écouteur.
      await get(path, { ...signed(path), "x-forwarded-for": HUB_IP, "cf-connecting-ip": HUB_IP }, "127.0.0.1"),
      await get(`${path}?q=a`, signed(`${path}?q=a`)),
      await get(`${path}?q=a`, signed(path)),
      await get("/api/hub/autre", signed("/api/hub/autre")),
      await get("/api/clients", signed("/api/clients")),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('{"error":"Not found"}');
    }
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"] as const) {
      const res = await hub.inject({ method, url: path, headers: signed(path), remoteAddress: HUB_IP });
      expect(res.statusCode).toBe(404);
    }
    expect((await get(path)).statusCode).toBe(200);
  });

  it("le journal ne contient ni nom de client, ni signature", async () => {
    const path = "/api/hub/clients";
    const headers = signed(path);
    await get(path, headers);
    await get(`${path}/${ids.perso}`);
    await get(path, { ...headers, "x-kouzia-hub-signature": "sha256=faux" });
    await get(path, headers, "10.0.0.9");
    const log = lines.join("\n");
    expect(log).toContain("hub_read_refused");
    for (const secret of ["Zénith", "Alice", "Martin", "Amis du Parc", headers["x-kouzia-hub-signature"], "sha256=", SECRET]) {
      expect(log).not.toContain(secret);
    }
  });

  it("limite de débit : au-delà de 60 par minute, la même 404", async () => {
    const app = await buildHubApp({ secret: SECRET, allowedIps, silent: true });
    const path = "/api/hub/clients";
    let last = 0;
    for (let i = 0; i < 61; i += 1) last = (await app.inject({ method: "GET", url: path, headers: signed(path), remoteAddress: HUB_IP })).statusCode;
    expect(last).toBe(404);
    await app.close();
  });

  it("requête venue du tunnel : 404 même depuis une IP autorisée (défense en profondeur)", async () => {
    // Montage hypothétique derrière cloudflared : request.ip vaut l'IP autorisée, seul viaTunnel refuse.
    const proxies = parseIpList(["loopback"], "TRUST_PROXY");
    const app = Fastify({ logger: false, trustProxy: trustProxyFn(proxies) });
    registerClientIpHook(app, proxies);
    await app.register(rateLimit, { global: false });
    await app.register(hubRoutes, { secret: SECRET, allowedIps: parseIpList([HUB_IP, "loopback"], "HUB_ALLOWED_IPS") });
    const path = "/api/hub/clients";
    const tunnel = await app.inject({ method: "GET", url: path, headers: { ...signed(path), "cf-connecting-ip": HUB_IP }, remoteAddress: "127.0.0.1" });
    expect(tunnel.statusCode).toBe(404);
    const lan = await app.inject({ method: "GET", url: path, headers: signed(path), remoteAddress: "127.0.0.1" });
    expect(lan.statusCode).toBe(200);
    await app.close();
  });

  it("l'app principale (tunnel et API_PORT) ne sert pas les routes du hub", async () => {
    const app = await buildApp({ serveStatic: false, silent: true });
    const path = "/api/hub/clients";
    const res = await app.inject({ method: "GET", url: path, headers: signed(path), remoteAddress: HUB_IP });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("configuration de l'écouteur du hub", () => {
  it("HUB_LISTEN : IP explicite et port, jamais toutes les interfaces", () => {
    expect(parseHubListen("192.168.1.20:3100")).toEqual({ host: "192.168.1.20", port: 3100 });
    expect(parseHubListen("[fd00::5]:3100")).toEqual({ host: "fd00::5", port: 3100 });
    for (const raw of ["0.0.0.0:3100", "[::]:3100", "[::0]:3100", "erp.lan:3100", "192.168.1.20", "192.168.1.20:0", "192.168.1.20:70000", ":3100"]) {
      expect(() => parseHubListen(raw), raw).toThrow(/HUB_LISTEN/);
    }
  });

  it("HUB_LISTEN : adresse privée seulement, toute écriture de l'adresse non spécifiée refusée", () => {
    for (const ok of ["10.0.0.4:3100", "172.20.1.2:3100", "127.0.0.1:3100", "[::ffff:192.168.1.20]:3100", "[::ffff:c0a8:114]:3100", "[fd12:3456::1]:3100"]) {
      expect(() => parseHubListen(ok), ok).not.toThrow();
    }
    for (const raw of [
      "[::0.0.0.0]:3100",
      "[::ffff:0.0.0.0]:3100",
      "[::ffff:0:0]:3100",
      "[0:0:0:0:0:ffff:0.0.0.0]:3100",
      "[0:0:0:0:0:0:0:0]:3100",
      "8.8.8.8:3100",
      "172.32.0.1:3100",
      "[2001:db8::1]:3100",
      "[::ffff:8.8.8.8]:3100",
    ]) {
      expect(() => parseHubListen(raw), raw).toThrow(/HUB_LISTEN/);
    }
  });

  it("HUB_READ_SECRET : 32 caractères au moins, message clair au démarrage", () => {
    expect(() => getHubConfig({ HUB_READ_SECRET: "trop-court", HUB_LISTEN: "192.168.1.20:3100", HUB_ALLOWED_IPS: HUB_IP })).toThrow(
      /HUB_READ_SECRET trop court \(10 caractères, 32 au moins\)/,
    );
    expect(getHubConfig({ HUB_READ_SECRET: "x".repeat(32), HUB_LISTEN: "192.168.1.20:3100", HUB_ALLOWED_IPS: HUB_IP })).not.toBeNull();
  });

  it("aucun écouteur sans HUB_READ_SECRET ou sans HUB_LISTEN", () => {
    expect(getHubConfig({ HUB_LISTEN: "192.168.1.20:3100", HUB_ALLOWED_IPS: HUB_IP })).toBeNull();
    expect(getHubConfig({ HUB_READ_SECRET: SECRET, HUB_ALLOWED_IPS: HUB_IP })).toBeNull();
    expect(getHubConfig({ HUB_READ_SECRET: " ", HUB_LISTEN: "192.168.1.20:3100" })).toBeNull();
    const config = getHubConfig({ HUB_READ_SECRET: SECRET, HUB_LISTEN: "192.168.1.20:3100", HUB_ALLOWED_IPS: `${HUB_IP}, 10.0.1.0/24` });
    expect(config).toMatchObject({ secret: SECRET, host: "192.168.1.20", port: 3100 });
    expect(config?.allowedIps.check("10.0.1.40", "ipv4")).toBe(true);
    expect(config?.allowedIps.check("10.0.2.1", "ipv4")).toBe(false);
    expect(() => getHubConfig({ HUB_READ_SECRET: SECRET, HUB_LISTEN: "192.168.1.20:3100", HUB_ALLOWED_IPS: "hub.lan" })).toThrow(/HUB_ALLOWED_IPS/);
  });
});
