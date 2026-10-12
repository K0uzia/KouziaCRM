import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { generateVapidKeys, vapidStatus } from "@/lib/push/vapid.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

const keys = generateVapidKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = "mailto:contact@kouzia.test";

type Captured = { url: string; headers: Record<string, string>; body: Buffer };
const captured: Captured[] = [];
let nextStatus = 201;
const realFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  if (typeof url === "string" && url.startsWith("https://push.example.test/")) {
    const body = init?.body;
    captured.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: Buffer.from(new Uint8Array(body as ArrayBuffer)),
    });
    return new Response(null, { status: nextStatus });
  }
  return realFetch(url, init);
}) as typeof fetch;

const { dispatchPushNotifications } = await import("@/lib/push/dispatch.js");
const { buildApp } = await import("@/app.js");

/** Appareil simulé : clés du navigateur, pour déchiffrer ce que le serveur envoie. */
function fakeBrowser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint: `https://push.example.test/${randomBytes(6).toString("hex")}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    /** Déchiffrement RFC 8291 (aes128gcm), comme le ferait le navigateur. */
    decrypt(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const cipher = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, info, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(cipher.subarray(cipher.length - 16));
      const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
      const end = plain.lastIndexOf(2);
      return JSON.parse(plain.subarray(0, end).toString("utf8"));
    },
  };
}

/** Vérifie la signature VAPID (JWT ES256) avec la clé publique du serveur. */
function vapidValid(authorization: string): boolean {
  const t = /t=([^,\s]+)/.exec(authorization)?.[1];
  const k = /k=([^,\s]+)/.exec(authorization)?.[1];
  if (!t || k !== keys.publicKey) return false;
  const [h, p, sig] = t.split(".");
  const raw = Buffer.from(k, "base64url");
  const pub = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
    format: "jwk",
  });
  return verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"));
}

const ADMIN = "admin-push@kouzia.test";
let app: FastifyInstance;
let cookie = "";
let userId = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  globalThis.fetch = realFetch;
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.pushSubscription.deleteMany();
  await prisma.companySettings.updateMany({ data: { pushDispatchedAt: null } });
  captured.length = 0;
  nextStatus = 201;
  const user = await prisma.user.upsert({
    where: { email: ADMIN },
    update: {},
    create: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") },
  });
  userId = user.id;
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

async function subscribe(device = fakeBrowser(), label = "Chrome sur Android") {
  const res = await app.inject({
    method: "POST",
    url: "/api/push/subscriptions",
    headers: { cookie },
    payload: { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth }, label },
  });
  return { res, device };
}

describe("clés VAPID", () => {
  it("générées au format web-push et lues par le serveur", () => {
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
    expect(vapidStatus().config?.publicKey).toBe(keys.publicKey);
  });

  it("absentes : désactivé avec la raison, sans erreur", () => {
    expect(vapidStatus({}).reason).toContain("clés VAPID absentes");
  });
});

describe("abonnement des appareils", () => {
  it("config, abonnement, liste ; même appareil réabonné : pas de doublon", async () => {
    const cfg = await app.inject({ method: "GET", url: "/api/push/config", headers: { cookie } });
    expect(cfg.json()).toEqual({ enabled: true, publicKey: keys.publicKey });
    const { res, device } = await subscribe();
    expect(res.statusCode).toBe(201);
    await subscribe(device, "Chrome sur Android (renouvelé)");
    const list = await app.inject({ method: "GET", url: "/api/push/subscriptions", headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].label).toBe("Chrome sur Android (renouvelé)");
  });

  it("endpoint non https refusé", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscriptions",
      headers: { cookie },
      payload: { endpoint: "http://push.example.test/x", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) }, label: "X" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sans session : 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/push/subscriptions" })).statusCode).toBe(401);
  });

  it("retrait d'un appareil", async () => {
    const { res } = await subscribe();
    const del = await app.inject({ method: "DELETE", url: `/api/push/subscriptions/${res.json().id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe("envoi", () => {
  it("test : chiffré pour l'appareil (RFC 8291), signé VAPID, déchiffrable", async () => {
    const { device } = await subscribe();
    const res = await app.inject({ method: "POST", url: "/api/push/test", headers: { cookie } });
    expect(res.json()).toMatchObject({ sent: 1, failed: 0 });
    const req = captured[0]!;
    expect(req.url).toBe(device.endpoint);
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(Number(req.headers.ttl)).toBeGreaterThan(0);
    expect(vapidValid(req.headers.authorization!)).toBe(true);
    expect(device.decrypt(req.body)).toMatchObject({ title: "Kouzia ERP", url: "/settings?tab=notifications" });
  });

  it("appareil disparu (410) : abonnement supprimé, message clair", async () => {
    await subscribe();
    nextStatus = 410;
    const res = await app.inject({ method: "POST", url: "/api/push/test", headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("plus abonné");
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe("événements de la cloche envoyés en push", () => {
  it("premier passage : repère posé sans rafale ; ensuite chaque événement une seule fois", async () => {
    const { device } = await subscribe();
    expect(await dispatchPushNotifications(new Date(Date.now() - 1000))).toBe(0);

    const client = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: client.id }, data: { onboardingCompletedAt: new Date() } });
    await prisma.emailThread.create({
      data: {
        subject: "Question sur le devis",
        lastMessageAt: new Date(),
        participants: JSON.stringify(["lou@example.test"]),
        messages: {
          create: {
            direction: "INBOUND",
            fromAddress: "lou@example.test",
            fromName: "Lou Martin",
            toAddresses: JSON.stringify(["contact@kouzia.test"]),
            subject: "Question sur le devis",
            receivedAt: new Date(),
            messageId: "<m1@example.test>",
          },
        },
      },
    });

    expect(await dispatchPushNotifications()).toBe(2);
    const payloads = captured.map((c) => device.decrypt(c.body) as { title: string; body: string; url: string });
    expect(payloads.map((p) => p.title).sort()).toEqual(["Nouveau client", "Nouveau message"]);
    const mail = payloads.find((p) => p.title === "Nouveau message")!;
    expect(mail.body).toBe("Lou Martin : Question sur le devis");
    expect(await dispatchPushNotifications()).toBe(0);
  });

  it("aucun appareil abonné : rien n'est envoyé, le repère avance", async () => {
    await prisma.companySettings.updateMany({ data: { pushDispatchedAt: new Date(Date.now() - 60_000) } });
    expect(await dispatchPushNotifications()).toBe(0);
    expect(captured).toHaveLength(0);
    expect(userId).toBeTruthy();
  });
});
