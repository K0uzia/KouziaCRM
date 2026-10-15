import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// SMTP « configuré » sans envoi réseau : l'e-mail reste dans la file, on l'y lit.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-acces@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";

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
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  cookie = `${SESSION_COOKIE}=${c?.value}`;
});

/** E-mails d'accès en file (le type est dans la charge utile JSON). */
const accessEmails = async () =>
  (await prisma.emailOutbox.findMany()).filter((m) => (JSON.parse(outboxPayloadRaw(m)) as { kind?: string }).kind === "access");

const create = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/clients", headers: { cookie }, payload });

describe("création d'un client et accès à l'espace client", () => {
  it("case cochée et adresse renseignée : e-mail d'accès envoyé", async () => {
    const res = await create({ type: "B2C", lastName: "Durand", email: "durand@example.com", sendPortalAccess: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().portalAccess).toEqual({ sent: true });
    expect(await accessEmails()).toHaveLength(1);
  });

  it("case décochée : aucun e-mail", async () => {
    const res = await create({ type: "B2C", lastName: "Durand", email: "durand@example.com", sendPortalAccess: false });
    expect(res.json().portalAccess).toBeNull();
    expect(await accessEmails()).toHaveLength(0);
  });

  it("sans adresse : aucun e-mail, même case cochée", async () => {
    const res = await create({ type: "B2C", lastName: "Sans Mail", sendPortalAccess: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().portalAccess).toBeNull();
    expect(await accessEmails()).toHaveLength(0);
  });

  it("option absente (autre appelant de l'API) : aucun e-mail", async () => {
    await create({ type: "B2C", lastName: "Durand", email: "durand@example.com" });
    expect(await accessEmails()).toHaveLength(0);
  });
});

describe("bouton « Envoyer l'accès à l'espace client »", () => {
  it("renvoi possible, client sans adresse signalé, client inconnu en 404", async () => {
    const withEmail = (await create({ type: "B2C", lastName: "Durand", email: "durand@example.com" })).json();
    const noEmail = (await create({ type: "B2C", lastName: "Sans Mail" })).json();
    const send = (id: string) =>
      app.inject({ method: "POST", url: `/api/clients/${id}/portal/welcome`, headers: { cookie } });

    expect((await send(withEmail.id)).json()).toEqual({ sent: true });
    expect((await send(withEmail.id)).json()).toEqual({ sent: true });
    expect(await accessEmails()).toHaveLength(2);
    expect((await send(noEmail.id)).json()).toEqual({ sent: false, reason: "no_email" });
    expect((await send("inconnu")).statusCode).toBe(404);
  });

  it("réservé à l'admin connecté", async () => {
    const res = await app.inject({ method: "POST", url: "/api/clients/x/portal/welcome" });
    expect(res.statusCode).toBe(401);
  });
});
