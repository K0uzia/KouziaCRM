// Création d'un client dans l'ERP : professionnels et associations seulement (décision du 27/10/2026). Un particulier
// est refusé en 422 à la création comme au passage d'une fiche vers « particulier » ; les fiches particulier déjà en
// base restent lisibles et modifiables sans changer de type. Le prénom et le nom saisis à la création d'un
// professionnel ou d'une association deviennent le contact principal, dans la même transaction que la fiche.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { decryptOptional, encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-particulier-refuse@kouzia.test";
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

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

/** Fiche particulier d'avant la décision, écrite directement en base (l'API n'en crée plus). */
async function legacyB2C() {
  const client = await prisma.client.create({
    data: {
      type: "B2C",
      displayName: "Lou Martin",
      firstName: "Lou",
      lastName: "Martin",
      emailEncrypted: encrypt("lou@example.test"),
      emailHash: computeEmailHash("lou@example.test"),
    },
  });
  await prisma.clientContact.create({
    data: { clientId: client.id, firstName: "Lou", lastName: "Martin", emailEncrypted: encrypt("lou@example.test"), emailHash: computeEmailHash("lou@example.test"), isPrimary: true },
  });
  return client;
}

describe("particulier refusé à la création et au changement de type", () => {
  it("création d'un particulier : 422 particulier_refuse, aucune fiche écrite", async () => {
    const res = await call("POST", "/api/clients", { type: "B2C", firstName: "Lou", lastName: "Martin", email: "lou@example.test", sendPortalAccess: false });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "particulier_refuse" });
    expect(res.json().error).toMatch(/professionnels et les associations/);
    expect(await prisma.client.count()).toBe(0);
    expect(await prisma.clientContact.count()).toBe(0);
  });

  it("professionnel passé en particulier : 422, fiche inchangée", async () => {
    const created = await call("POST", "/api/clients", { type: "B2B", companyName: "Atelier Dupont", sendPortalAccess: false });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const res = await call("PUT", `/api/clients/${id}`, { type: "B2C", lastName: "Dupont" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "particulier_refuse" });
    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(row.type).toBe("B2B");
    expect(row.displayName).toBe("Atelier Dupont");
  });

  it("particulier déjà en base : lu, modifié sans changer de type, et peut devenir professionnel", async () => {
    const client = await legacyB2C();
    const get = await call("GET", `/api/clients/${client.id}`);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ type: "B2C", displayName: "Lou Martin" });

    const put = await call("PUT", `/api/clients/${client.id}`, { type: "B2C", firstName: "Lou", lastName: "Martin-Durand", email: "lou@example.test" });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ type: "B2C", displayName: "Lou Martin-Durand" });

    const toPro = await call("PUT", `/api/clients/${client.id}`, { type: "B2B", companyName: "Lou Martin Conseil", firstName: "Lou", lastName: "Martin-Durand", email: "lou@example.test" });
    expect(toPro.statusCode).toBe(200);
    expect(toPro.json()).toMatchObject({ type: "B2B", displayName: "Lou Martin Conseil" });
  });
});

describe("contact principal saisi à la création", () => {
  it.each([
    ["B2B", "Atelier Dupont"],
    ["ASSOCIATION", "Les Amis du Port"],
  ] as const)("%s : prénom, nom, e-mail et téléphone deviennent le contact principal", async (type, companyName) => {
    const res = await call("POST", "/api/clients", {
      type,
      companyName,
      firstName: " Camille ",
      lastName: "Dupont",
      email: "camille@example.test",
      phone: "06 12 34 56 78",
      sendPortalAccess: false,
    });
    expect(res.statusCode).toBe(201);
    const client = res.json() as { id: string; displayName: string; firstName: string | null; lastName: string | null };
    expect(client).toMatchObject({ displayName: companyName, firstName: "Camille", lastName: "Dupont" });
    const contacts = await prisma.clientContact.findMany({ where: { clientId: client.id } });
    expect(contacts).toHaveLength(1);
    const [primary] = contacts;
    expect(primary).toMatchObject({ firstName: "Camille", lastName: "Dupont", role: null, isPrimary: true, emailHash: computeEmailHash("camille@example.test") });
    expect(decryptOptional(primary!.emailEncrypted)).toBe("camille@example.test");
    expect(decryptOptional(primary!.phoneEncrypted)).toBe("06 12 34 56 78");
  });

  it("sans nom ni coordonnées : aucun contact ; e-mail seul : « Contact principal »", async () => {
    const bare = (await call("POST", "/api/clients", { type: "B2B", companyName: "Sans Contact", sendPortalAccess: false })).json();
    expect(await prisma.clientContact.count({ where: { clientId: bare.id } })).toBe(0);
    const mailOnly = (await call("POST", "/api/clients", { type: "B2B", companyName: "Mail Seul", email: "contact@mail-seul.test", sendPortalAccess: false })).json();
    const contact = await prisma.clientContact.findFirstOrThrow({ where: { clientId: mailOnly.id } });
    expect(contact).toMatchObject({ firstName: null, lastName: null, role: "Contact principal", isPrimary: true });
  });
});
