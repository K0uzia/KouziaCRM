import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { base32Decode, hotp, totpStep } from "@/lib/admin/totp.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 (Session.mfaVerified) : une session ouverte en LAN par mot de passe seul n'était
// pas liée au canal ; son cookie, réutilisé par le tunnel, ouvrait l'admin sans double authentification. Par le tunnel,
// seule une session vérifiée par le code (connexion avec 2FA, ou activation de la 2FA) est acceptée.
const EMAIL = "admin-session-mfa@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const previousTrust = process.env.TRUST_PROXY;
const previousAdmin = process.env.ADMIN_PUBLIC_ORIGIN;
process.env.TRUST_PROXY = "true";
process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.kouzia.test";
const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
let ipSeq = 1;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  if (previousTrust === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previousTrust;
  if (previousAdmin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN;
  else process.env.ADMIN_PUBLIC_ORIGIN = previousAdmin;
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.user.create({ data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD) } });
});

type Jar = Record<string, string>;
type Origin = { remoteAddress: string; headers: Record<string, string> };
const tunnel = (): Origin => ({ remoteAddress: "127.0.0.1", headers: { host: "erp.kouzia.test", "cf-connecting-ip": `198.51.100.${ipSeq++ % 250}` } });
const lan = (): Origin => ({ remoteAddress: `192.168.1.${ipSeq++ % 250}`, headers: {} });

function store(jar: Jar, res: LightMyRequestResponse): Jar {
  for (const c of res.cookies) {
    if (c.value === "" || (c.expires && new Date(c.expires).getTime() < Date.now())) delete jar[c.name];
    else jar[c.name] = c.value;
  }
  return jar;
}
async function call(jar: Jar, origin: Origin, method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, cookies: jar, ...origin });
  store(jar, res);
  return res;
}
const code = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep(Date.now()) + offset);
const me = async (jar: Jar, origin: Origin) => (await call(jar, origin, "GET", "/api/auth/me")).json().user;

async function enroll(jar: Jar) {
  expect((await call(jar, lan(), "POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).statusCode).toBe(200);
  const { secret } = (await call(jar, lan(), "POST", "/api/auth/2fa/setup")).json() as { secret: string };
  expect((await call(jar, lan(), "POST", "/api/auth/2fa/enable", { code: code(secret, -1) })).statusCode).toBe(200);
  return secret;
}

describe("session vérifiée par la double authentification", () => {
  it("session LAN par mot de passe seul : refusée par le tunnel, acceptée en LAN", async () => {
    const jar: Jar = {};
    expect((await call(jar, lan(), "POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).statusCode).toBe(200);
    expect(await me(jar, lan())).toMatchObject({ email: EMAIL });
    expect(await me({ ...jar }, tunnel())).toBeNull();
    expect((await call({ ...jar }, tunnel(), "GET", "/api/clients")).statusCode).toBe(401);
    expect(await me(jar, lan())).toMatchObject({ email: EMAIL });
  });

  it("2FA activée ensuite : une session antérieure non vérifiée reste refusée par le tunnel", async () => {
    const old: Jar = {};
    expect((await call(old, lan(), "POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).statusCode).toBe(200);
    await enroll({});
    expect(await me({ ...old }, tunnel())).toBeNull();
  });

  it("connexion par le tunnel avec le code : session acceptée par le tunnel", async () => {
    const secret = await enroll({});
    const jar: Jar = {};
    expect((await call(jar, tunnel(), "POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).json()).toEqual({ mfaRequired: true });
    expect((await call(jar, tunnel(), "POST", "/api/auth/2fa", { code: code(secret) })).statusCode).toBe(200);
    expect(await me(jar, tunnel())).toMatchObject({ email: EMAIL });
  });

  it("activation de la 2FA (code saisi) : la session qui l'active est vérifiée", async () => {
    const jar: Jar = {};
    await enroll(jar);
    expect(await me(jar, tunnel())).toMatchObject({ email: EMAIL });
  });
});
