import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { base32Decode, hotp, totpStep } from "@/lib/admin/totp.js";
import { CHALLENGE_COOKIE, LOCK_AFTER_FAILURES } from "@/lib/admin/two-factor.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const EMAIL = "admin-2fa@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";

const previousTrust = process.env.TRUST_PROXY;
process.env.TRUST_PROXY = "true";
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
});

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.user.create({ data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD) } });
});

type Jar = Record<string, string>;
type Origin = { remoteAddress: string; headers: Record<string, string> };

function store(jar: Jar, res: LightMyRequestResponse): Jar {
  for (const c of res.cookies) {
    if (c.value === "" || (c.expires && new Date(c.expires).getTime() < Date.now())) delete jar[c.name];
    else jar[c.name] = c.value;
  }
  return jar;
}

/** Requête venue d'Internet par cloudflared (IP différente à chaque fois : pas de limite de débit commune). */
function tunnel(): Origin {
  return { remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": `198.51.100.${ipSeq++ % 250}` } };
}
const lan = (): Origin => ({ remoteAddress: `192.168.1.${ipSeq++ % 250}`, headers: {} });

async function call(
  jar: Jar,
  origin: Origin,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({ method, url, payload: payload as object, cookies: jar, ...origin });
  store(jar, res);
  return res;
}

const login = (jar: Jar, origin = tunnel(), password = PASSWORD) =>
  call(jar, origin, "POST", "/api/auth/login", { email: EMAIL, password });

const currentCode = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep(Date.now()) + offset);

/** Active la 2FA depuis le LAN, renvoie le secret et les codes de secours. */
async function enroll() {
  const jar: Jar = {};
  expect((await login(jar, lan())).statusCode).toBe(200);
  const setup = await call(jar, lan(), "POST", "/api/auth/2fa/setup");
  expect(setup.statusCode).toBe(200);
  const { secret, qrSvg, otpauthUri } = setup.json() as { secret: string; qrSvg: string; otpauthUri: string };
  expect(qrSvg).toMatch(/^<svg/);
  expect(otpauthUri).toContain(`secret=${secret}`);
  const enable = await call(jar, lan(), "POST", "/api/auth/2fa/enable", { code: currentCode(secret, -1) });
  expect(enable.statusCode).toBe(200);
  const { recoveryCodes } = enable.json() as { recoveryCodes: string[] };
  return { secret, recoveryCodes, jar };
}

describe("connexion sans 2FA", () => {
  it("LAN : session posée", async () => {
    const jar: Jar = {};
    const res = await login(jar, lan());
    expect(res.statusCode).toBe(200);
    expect(jar[SESSION_COOKIE]).toBeTruthy();
    const me = await call(jar, lan(), "GET", "/api/auth/me");
    expect(me.json()).toMatchObject({ user: { email: EMAIL } });
  });

  it("tunnel : refusée tant que la 2FA n'est pas activée, aucune session", async () => {
    const jar: Jar = {};
    const res = await login(jar);
    expect(res.statusCode).toBe(403);
    expect(jar[SESSION_COOKIE]).toBeUndefined();
  });

  it("le jeton du cookie n'est pas stocké en clair", async () => {
    const jar: Jar = {};
    await login(jar, lan());
    const token = jar[SESSION_COOKIE]!;
    expect(await prisma.session.count({ where: { id: token } })).toBe(0);
    expect(await prisma.session.count()).toBe(1);
  });
});

describe("enrôlement", () => {
  it("un mauvais code n'active rien ; le bon active et donne 10 codes de secours", async () => {
    const jar: Jar = {};
    await login(jar, lan());
    const { secret } = (await call(jar, lan(), "POST", "/api/auth/2fa/setup")).json() as { secret: string };
    const wrong = await call(jar, lan(), "POST", "/api/auth/2fa/enable", { code: "000000" === currentCode(secret) ? "111111" : "000000" });
    expect(wrong.statusCode).toBe(400);
    expect((await call(jar, lan(), "GET", "/api/auth/2fa/status")).json()).toMatchObject({ enabled: false });

    const ok = await call(jar, lan(), "POST", "/api/auth/2fa/enable", { code: currentCode(secret) });
    const { recoveryCodes } = ok.json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect((await call(jar, lan(), "GET", "/api/auth/2fa/status")).json()).toMatchObject({
      enabled: true,
      recoveryCodesRemaining: 10,
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.totpSecretEncrypted).not.toContain(secret);
    const again = await call(jar, lan(), "POST", "/api/auth/2fa/setup");
    expect(again.statusCode).toBe(409);
  });
});

describe("connexion avec 2FA", () => {
  it("mot de passe seul : pas de session ; code TOTP : session", async () => {
    const { secret } = await enroll();
    const jar: Jar = {};
    const first = await login(jar);
    expect(first.json()).toEqual({ mfaRequired: true });
    expect(jar[SESSION_COOKIE]).toBeUndefined();
    expect(jar[CHALLENGE_COOKIE]).toBeTruthy();
    expect((await call(jar, tunnel(), "GET", "/api/auth/me")).json()).toEqual({ user: null });

    const second = await call(jar, tunnel(), "POST", "/api/auth/2fa", { code: currentCode(secret, 1) });
    expect(second.statusCode).toBe(200);
    expect(jar[SESSION_COOKIE]).toBeTruthy();
    expect(jar[CHALLENGE_COOKIE]).toBeUndefined();
    expect(second.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
  });

  it("anti-rejeu : un code déjà accepté est refusé", async () => {
    const { secret } = await enroll();
    const code = currentCode(secret, 1);
    const a: Jar = {};
    await login(a);
    expect((await call(a, tunnel(), "POST", "/api/auth/2fa", { code })).statusCode).toBe(200);
    const b: Jar = {};
    await login(b);
    expect((await call(b, tunnel(), "POST", "/api/auth/2fa", { code })).statusCode).toBe(401);
  });

  it("code de secours : accepté une seule fois", async () => {
    const { recoveryCodes } = await enroll();
    const a: Jar = {};
    await login(a);
    const used = recoveryCodes[0]!.toLowerCase();
    expect((await call(a, tunnel(), "POST", "/api/auth/2fa", { recoveryCode: used })).statusCode).toBe(200);
    const b: Jar = {};
    await login(b);
    expect((await call(b, tunnel(), "POST", "/api/auth/2fa", { recoveryCode: used })).statusCode).toBe(401);
  });

  it("challenge épuisé après 5 mauvais codes", async () => {
    const { secret } = await enroll();
    const jar: Jar = {};
    await login(jar);
    for (let i = 0; i < 5; i++) {
      await call(jar, lan(), "POST", "/api/auth/2fa", { code: "000000" });
    }
    const res = await call(jar, lan(), "POST", "/api/auth/2fa", { code: currentCode(secret, 1) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/expirée/) });
  });
});

describe("verrouillage", () => {
  it(`${LOCK_AFTER_FAILURES} échecs par le tunnel verrouillent le tunnel, pas le LAN`, async () => {
    for (let i = 0; i < LOCK_AFTER_FAILURES; i++) {
      expect((await login({}, tunnel(), "mauvais")).statusCode).toBe(401);
    }
    // Bon mot de passe, même réponse qu'un échec : le verrouillage ne se devine pas.
    const locked = await login({}, tunnel());
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toEqual({ error: "Email ou mot de passe incorrect" });
    expect((await login({}, lan())).statusCode).toBe(200);
  });

  it("email inconnu : même réponse qu'un mauvais mot de passe", async () => {
    const res = await call({}, tunnel(), "POST", "/api/auth/login", { email: "inconnu@kouzia.test", password: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Email ou mot de passe incorrect" });
  });
});
