import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE, SESSION_IDLE_MS, SESSION_TTL_MS } from "@/lib/auth.js";
import { PORTAL_COOKIE, SESSION_TTL_MS as PORTAL_TTL_MS, setPortalCookies } from "@/lib/portal/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-sessions@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const DAY = 86_400_000;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
});

let ip = 0;
async function login() {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD }, remoteAddress: `10.5.0.${++ip % 250}` });
  expect(res.statusCode, res.body).toBe(200);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const session = await prisma.session.findFirstOrThrow({ where: { user: { email: ADMIN } }, orderBy: { createdAt: "desc" } });
  return { cookie: `${SESSION_COOKIE}=${token}`, session, setCookie: res.cookies.find((c) => c.name === SESSION_COOKIE)! };
}
/** 200 : session valide ; 401 : session refusée (route admin). /api/auth/me répond alors { user: null } et la SPA revient à la connexion. */
const me = async (cookie: string) => {
  const res = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
  if (res.statusCode === 401) {
    const who = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(who.json()).toEqual({ user: null });
  }
  return res;
};

describe("session admin : 7 jours au plus, close après 24 h d'inactivité", () => {
  it("nouvelle session : cookie et expiration à 7 jours, activité enregistrée", async () => {
    const { session, setCookie } = await login();
    expect(SESSION_TTL_MS).toBe(7 * DAY);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(7 * DAY + 5_000);
    expect(session.lastSeenAt).not.toBeNull();
    expect(new Date(setCookie.expires!).getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY + 5_000);
  });

  it("24 h sans requête : 401 (retour à la connexion), session supprimée", async () => {
    const { cookie, session } = await login();
    expect((await me(cookie)).statusCode).toBe(200);
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(Date.now() - SESSION_IDLE_MS - 60_000) } });
    expect((await me(cookie)).statusCode).toBe(401);
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it("session ouverte avant le déploiement (14 jours, sans activité enregistrée) : valable jusqu'à 7 jours après sa création", async () => {
    const { cookie, session } = await login();
    // Session d'avant : expiration à 14 jours, lastSeenAt nul.
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: null, createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() + 11 * DAY) } });
    expect((await me(cookie)).statusCode).toBe(200);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt).not.toBeNull();

    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: null, createdAt: new Date(Date.now() - 8 * DAY) } });
    const expired = await me(cookie);
    expect(expired.statusCode).toBe(401);
    // Reconnexion normale ensuite (le mot de passe, puis la double authentification si elle est active).
    expect((await me((await login()).cookie)).statusCode).toBe(200);
  });

  it("activité récente : la date n'est réécrite qu'au-delà de 5 minutes", async () => {
    const { cookie, session } = await login();
    const recent = new Date(Date.now() - 60_000);
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: recent } });
    await me(cookie);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt?.getTime()).toBe(recent.getTime());
  });
});

describe("espace client : 7 jours, cookie Secure par le tunnel", () => {
  it("durée de session à 7 jours ; cookie Secure dès que la requête vient du tunnel", () => {
    expect(PORTAL_TTL_MS).toBe(7 * DAY);
    for (const viaTunnel of [true, false]) {
      const set: Array<{ name: string; secure: boolean }> = [];
      const reply = { request: { viaTunnel }, setCookie: (name: string, _v: string, opts: { secure: boolean }) => set.push({ name, secure: opts.secure }) } as unknown as FastifyReply;
      setPortalCookies(reply, { token: "jeton", expiresAt: new Date(Date.now() + PORTAL_TTL_MS) }, "appareil");
      const portal = set.find((c) => c.name === PORTAL_COOKIE)!;
      if (viaTunnel) expect(portal.secure).toBe(true);
      else expect(portal.secure).toBe(process.env.COOKIE_SECURE === "true");
    }
  });
});
