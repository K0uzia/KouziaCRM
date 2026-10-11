import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Appels du site kouzia.com vers api.kouzia.com, tels que le navigateur les envoie.
const SITE = "https://kouzia.com";
process.env.PUBLIC_WEB_ORIGIN = SITE;

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");

const EMAIL = "camille@exemple.fr";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
});

async function login(): Promise<string> {
  const client = await createClient({ displayName: "Camille Dupont", type: "B2C" });
  await prisma.client.update({
    where: { id: client.id },
    data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  await app.inject({ method: "POST", url: "/api/public/auth/code", headers: { origin: SITE }, payload: { email: EMAIL } });
  for (let i = 0; i < 50 && (await prisma.emailOutbox.count()) < 1; i++) await new Promise((ok) => setTimeout(ok, 20));
  const row = await prisma.emailOutbox.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  const code = parsePayload(row.payload).subject.match(/^(\d{6}) /)![1];
  const res = await app.inject({
    method: "POST",
    url: "/api/public/auth/verify",
    headers: { origin: SITE },
    payload: { email: EMAIL, code },
  });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === "kz_portal")!.value;
}

describe("espace client depuis kouzia.com", () => {
  it("préflight CORS de la déconnexion accepté", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/public/auth/logout",
      headers: {
        origin: SITE,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  for (const [cas, headers, payload] of [
    ["sans corps", {}, undefined],
    ["JSON vide {}", { "content-type": "application/json" }, "{}"],
    ["Content-Type JSON sans corps", { "content-type": "application/json" }, ""],
  ] as const) {
    it(`déconnexion ${cas} : session révoquée et cookie effacé avec les attributs de la pose`, async () => {
      const token = await login();
      const res = await app.inject({
        method: "POST",
        url: "/api/public/auth/logout",
        headers: { origin: SITE, ...headers },
        cookies: { kz_portal: token },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
      const cleared = res.cookies.find((c) => c.name === "kz_portal");
      expect(cleared?.value).toBe("");
      expect(cleared?.path).toBe("/api/public");
      expect(cleared?.httpOnly).toBe(true);
      expect(cleared?.sameSite).toBe("Lax");
      expect(cleared?.domain).toBeUndefined();
      expect(new Date(cleared!.expires!).getTime()).toBeLessThanOrEqual(Date.now());

      const after = await app.inject({
        method: "GET",
        url: "/api/public/tracking",
        headers: { origin: SITE },
        cookies: { kz_portal: token },
      });
      expect(after.statusCode).toBe(401);
    });
  }

  it("adresse non cliente : réponses normales avec en-têtes CORS (aucune erreur réseau)", async () => {
    const code = await app.inject({
      method: "POST",
      url: "/api/public/auth/code",
      headers: { origin: SITE },
      payload: { email: "inconnu@exemple.fr" },
    });
    expect(code.statusCode).toBe(200);
    expect(code.headers["access-control-allow-origin"]).toBe(SITE);

    const verify = await app.inject({
      method: "POST",
      url: "/api/public/auth/verify",
      headers: { origin: SITE },
      payload: { email: "inconnu@exemple.fr", code: "123456" },
    });
    expect(verify.statusCode).toBe(401);
    expect(verify.headers["access-control-allow-origin"]).toBe(SITE);
    expect(verify.json().error).toBeTruthy();
  });
});
