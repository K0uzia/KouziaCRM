// Contacts multiples : contact principal synchronisé avec la fiche (référence de l'espace client), un seul principal,
// adresse d'un autre client refusée, rattachement des e-mails par un contact secondaire, reprise idempotente.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { decryptOptional, encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { runTakeovers, takeoverSummary } from "@/lib/reprises/index.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-contacts@kouzia.test";
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
  await prisma.clientContact.deleteMany();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function newClient(extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/api/clients", { type: "B2C", firstName: "Lou", lastName: "Martin", email: "lou@example.test", phone: "06 12 34 56 78", sendPortalAccess: false, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; displayName: string };
}

const contactsOf = async (id: string) =>
  (await call("GET", `/api/clients/${id}/contacts`)).json() as Array<{ id: string; firstName: string | null; lastName: string | null; role: string | null; email: string | null; phone: string | null; isPrimary: boolean }>;

describe("contact principal synchronisé avec la fiche", () => {
  it("création de la fiche : contact principal créé, chiffré au repos, avec emailHash", async () => {
    const client = await newClient();
    const [primary, ...rest] = await contactsOf(client.id);
    expect(rest).toHaveLength(0);
    expect(primary).toMatchObject({ firstName: "Lou", lastName: "Martin", role: null, email: "lou@example.test", phone: "06 12 34 56 78", isPrimary: true });
    const row = await prisma.clientContact.findFirstOrThrow({ where: { clientId: client.id } });
    expect(row.emailEncrypted).not.toContain("example");
    expect(row.phoneEncrypted).not.toContain("06");
    expect(row.emailHash).toBe(computeEmailHash("lou@example.test"));
  });

  it("modification de la fiche : le contact principal suit ; les autres contacts ne bougent pas", async () => {
    const client = await newClient();
    await call("POST", `/api/clients/${client.id}/contacts`, { firstName: "Sam", role: "Comptable", email: "sam@example.test" });
    const put = await call("PUT", `/api/clients/${client.id}`, { type: "B2C", firstName: "Lou", lastName: "Martin-Durand", email: "lou.md@example.test", phone: null });
    expect(put.statusCode).toBe(200);
    const [primary, other] = await contactsOf(client.id);
    expect(primary).toMatchObject({ lastName: "Martin-Durand", email: "lou.md@example.test", phone: null, isPrimary: true });
    expect(other).toMatchObject({ firstName: "Sam", email: "sam@example.test", isPrimary: false });
  });

  it("autre contact désigné principal : un seul principal, ses coordonnées deviennent celles de la fiche (nom affiché d'un particulier compris)", async () => {
    const client = await newClient();
    const added = (await call("POST", `/api/clients/${client.id}/contacts`, { firstName: "Camille", lastName: "Martin", email: "camille@example.test" })).json();
    const res = await call("POST", `/api/clients/${client.id}/contacts/${added.id}/primary`);
    expect(res.statusCode).toBe(200);
    const list = await contactsOf(client.id);
    expect(list.filter((c) => c.isPrimary).map((c) => c.firstName)).toEqual(["Camille"]);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(decryptOptional(row.emailEncrypted)).toBe("camille@example.test");
    expect(row.emailHash).toBe(computeEmailHash("camille@example.test"));
    expect(row.phoneEncrypted).toBeNull();
    expect(row.displayName).toBe("Camille Martin");
  });

  it("adresse déjà portée par une autre fiche : 409, rien ne change", async () => {
    await newClient({ firstName: "Autre", email: "pris@example.test" });
    const client = await newClient({ email: "lou2@example.test" });
    const added = (await call("POST", `/api/clients/${client.id}/contacts`, { firstName: "Doublon", email: "pris@example.test" })).json();
    const res = await call("POST", `/api/clients/${client.id}/contacts/${added.id}/primary`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "email_taken" });
    const list = await contactsOf(client.id);
    expect(list.find((c) => c.isPrimary)?.email).toBe("lou2@example.test");
    expect(decryptOptional((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).emailEncrypted)).toBe("lou2@example.test");
  });

  it("contact principal non supprimable (409) ; un autre se supprime ; premier contact d'une fiche vide : principal d'office", async () => {
    const client = await newClient();
    const [primary] = await contactsOf(client.id);
    expect((await call("DELETE", `/api/clients/${client.id}/contacts/${primary!.id}`)).json()).toMatchObject({ code: "primary_required" });
    const added = (await call("POST", `/api/clients/${client.id}/contacts`, { firstName: "Sam" })).json();
    expect((await call("DELETE", `/api/clients/${client.id}/contacts/${added.id}`)).statusCode).toBe(200);
    expect(await contactsOf(client.id)).toHaveLength(1);

    const empty = await newClient({ type: "B2B", companyName: "Exemple SARL", firstName: null, lastName: null, email: null, phone: null });
    expect(await contactsOf(empty.id)).toHaveLength(0);
    const first = (await call("POST", `/api/clients/${empty.id}/contacts`, { firstName: "Gérante", email: "gerante@example.test" })).json();
    expect(first.isPrimary).toBe(true);
    expect(decryptOptional((await prisma.client.findUniqueOrThrow({ where: { id: empty.id } })).emailEncrypted)).toBe("gerante@example.test");
  });

  it("validation (400), inconnus (404), sans session (401)", async () => {
    const client = await newClient();
    expect((await call("POST", `/api/clients/${client.id}/contacts`, { role: "Sans rien" })).statusCode).toBe(400);
    expect((await call("POST", `/api/clients/${client.id}/contacts`, { firstName: "X", email: "pas-une-adresse" })).statusCode).toBe(400);
    expect((await call("POST", "/api/clients/inconnu/contacts", { firstName: "X" })).statusCode).toBe(404);
    expect((await call("PUT", `/api/clients/${client.id}/contacts/inconnu`, { firstName: "X" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/clients/${client.id}/contacts` })).statusCode).toBe(401);
  });

  it("export RGPD : les contacts y figurent, déchiffrés", async () => {
    const client = await newClient();
    const res = await call("GET", `/api/clients/${client.id}/export`);
    expect(res.json().contacts).toMatchObject([{ email: "lou@example.test", isPrimary: true }]);
  });
});

describe("rattachement d'un e-mail entrant par un contact", () => {
  it("adresse d'un contact secondaire : rattachée à son client ; partagée par deux clients : aucun rattachement", async () => {
    const a = await newClient({ email: "a@example.test" });
    const b = await newClient({ firstName: "Bea", email: "b@example.test" });
    await call("POST", `/api/clients/${a.id}/contacts`, { firstName: "Compta", email: "compta-a@example.test" });
    expect(await findClientIdByEmail("Compta-A@Example.test ")).toBe(a.id);
    await call("POST", `/api/clients/${a.id}/contacts`, { role: "Standard", email: "standard@example.test" });
    await call("POST", `/api/clients/${b.id}/contacts`, { role: "Standard", email: "standard@example.test" });
    expect(await findClientIdByEmail("standard@example.test")).toBeNull();
    expect(await findClientIdByEmail("b@example.test")).toBe(b.id);
  });
});

describe("reprise des contacts", () => {
  it("à blanc puis réelle : un principal par fiche qui a un nom, un e-mail ou un téléphone ; sans nom : « Contact principal » ; relancée : zéro", async () => {
    const before = new Date("2026-10-01T08:00:00Z");
    // Fiches d'avant la migration (aucun contact) : écrites directement.
    const particulier = await prisma.client.create({
      data: { type: "B2C", displayName: "Lou Martin", firstName: "Lou", lastName: "Martin", emailEncrypted: encrypt("lou@example.test"), emailHash: computeEmailHash("lou@example.test"), phoneEncrypted: encrypt("0612345678"), updatedAt: before },
    });
    const pro = await prisma.client.create({
      data: { type: "B2B", displayName: "Exemple Pro SARL", companyName: "Exemple Pro SARL", emailEncrypted: encrypt("contact@example.test"), emailHash: computeEmailHash("contact@example.test") },
    });
    await prisma.client.create({ data: { type: "ASSOCIATION", displayName: "Association Exemple", companyName: "Association Exemple" } });

    const dry = await runTakeovers({ dryRun: true });
    expect(dry.contacts).toEqual({ contacts: 2, withEmail: 2, withPhone: 1, unnamed: 1, skipped: 1 });
    expect(await prisma.clientContact.count()).toBe(0);
    expect(takeoverSummary(dry)[2]).toBe(
      "  contacts : 2 contacts principaux créés (2 avec e-mail, 1 avec téléphone, 1 sans nom « Contact principal »), 1 fiche sans nom, e-mail ni téléphone laissée sans contact",
    );

    const real = await runTakeovers({ dryRun: false });
    expect(real.contacts).toEqual(dry.contacts);
    const lou = await prisma.clientContact.findFirstOrThrow({ where: { clientId: particulier.id } });
    expect(lou).toMatchObject({ firstName: "Lou", lastName: "Martin", role: null, isPrimary: true, emailHash: computeEmailHash("lou@example.test") });
    expect(decryptOptional(lou.emailEncrypted)).toBe("lou@example.test");
    expect(decryptOptional(lou.phoneEncrypted)).toBe("0612345678");
    const proContact = await prisma.clientContact.findFirstOrThrow({ where: { clientId: pro.id } });
    expect(proContact).toMatchObject({ firstName: null, lastName: null, role: "Contact principal", isPrimary: true });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: particulier.id } })).updatedAt.toISOString()).toBe(before.toISOString());

    expect((await runTakeovers({ dryRun: false })).contacts).toEqual({ contacts: 0, withEmail: 0, withPhone: 0, unnamed: 0, skipped: 1 });
    expect(await prisma.clientContact.count()).toBe(2);
    expect(JSON.stringify(real)).not.toMatch(/Lou|Martin|example|Exemple|06/);
  });
});
