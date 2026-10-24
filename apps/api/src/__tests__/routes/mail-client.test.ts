import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt, decryptOptional } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const { companyFromDomain, splitSenderName } = await import("@/lib/email/sender-client.js");

const ADMIN = "admin-mail-client@kouzia.test";
let app: FastifyInstance;
let cookie = "";
let folderId = "";
let uid = 0;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  const account = await prisma.mailAccount.create({ data: { email: "contact@kouzia.test", isDefault: true } });
  folderId = (await prisma.mailFolder.create({ data: { accountId: account.id, imapPath: "INBOX", displayName: "Réception", role: "INBOX" } })).id;
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, payload: payload as never });

/** Fil d'un message reçu ; fromAddress tel que reçu (casse comprise). */
async function received(fromAddress: string, fromName: string | null, clientId: string | null = null) {
  uid += 1;
  const t = await prisma.emailThread.create({ data: { subject: `Demande ${uid}`, participants: "[]", lastMessageAt: new Date(), clientId } });
  await prisma.emailMessage.create({
    data: {
      threadId: t.id, direction: "INBOUND", messageId: `<m-${uid}@exemple.test>`, fromAddress, fromName,
      subject: `Demande ${uid}`, toAddresses: "[]", bodyText: "Bonjour", receivedAt: new Date(), folderId, imapUid: uid,
    },
  });
  return t;
}

describe("expéditeur sans client : proposition", () => {
  it("nom découpé, entreprise depuis le domaine, rien pour une messagerie grand public", () => {
    expect(splitSenderName("Jeanne Martin-Dupont", "j@atelier-bois.fr")).toEqual({ firstName: "Jeanne", lastName: "Martin-Dupont" });
    expect(splitSenderName(null, "jean.dupont@gmail.com")).toEqual({ firstName: "Jean", lastName: "Dupont" });
    expect(splitSenderName("", "contact@atelier-bois.fr")).toEqual({ firstName: "", lastName: "" });
    expect(companyFromDomain("j@atelier-bois.fr")).toBe("Atelier Bois");
    expect(companyFromDomain("j@mail.atelier-bois.fr")).toBe("Atelier Bois");
    for (const webmail of ["gmail.com", "outlook.fr", "orange.fr", "free.fr", "laposte.net", "icloud.com"]) {
      expect(companyFromDomain(`x@${webmail}`)).toBeNull();
    }
  });

  it("GET du fil : senderSuggestion sans client ; fiche connue signalée ; rien une fois rattaché", async () => {
    const t = await received("Jeanne@Atelier-Bois.fr", "Jeanne Martin");
    const res = await call("GET", `/api/emails/${t.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().senderSuggestion).toEqual({
      email: "jeanne@atelier-bois.fr",
      firstName: "Jeanne",
      lastName: "Martin",
      company: "Atelier Bois",
      knownClient: null,
    });

    const client = await createClient({ displayName: "Atelier Bois" });
    await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("jeanne@atelier-bois.fr"), emailHash: computeEmailHash("jeanne@atelier-bois.fr") } });
    expect((await call("GET", `/api/emails/${t.id}`)).json().senderSuggestion.knownClient).toEqual({ id: client.id, displayName: "Atelier Bois" });

    await prisma.emailThread.update({ where: { id: t.id }, data: { clientId: client.id } });
    expect((await call("GET", `/api/emails/${t.id}`)).json().senderSuggestion).toBeNull();
  });
});

describe("POST /api/emails/:threadId/link-client", () => {
  it("rattache ce fil et les autres fils sans client de l'adresse, jamais ceux d'un autre client", async () => {
    const t1 = await received("jeanne@atelier-bois.fr", "Jeanne Martin");
    const t2 = await received("JEANNE@atelier-bois.fr", null);
    const other = await received("autre@exemple.test", null);
    const elsewhere = await createClient({ displayName: "Déjà rattaché" });
    const t3 = await received("jeanne@atelier-bois.fr", null, elsewhere.id);
    const client = await createClient({ displayName: "Atelier Bois" });

    const res = await call("POST", `/api/emails/${t1.id}/link-client`, { clientId: client.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ client: { id: client.id, displayName: "Atelier Bois" }, linkedThreads: 2, contactAdded: false });
    const byId = async (id: string) => (await prisma.emailThread.findUniqueOrThrow({ where: { id } })).clientId;
    expect(await byId(t1.id)).toBe(client.id);
    expect(await byId(t2.id)).toBe(client.id);
    expect(await byId(other.id)).toBeNull();
    expect(await byId(t3.id)).toBe(elsewhere.id);
    expect(await prisma.clientContact.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("avec le contact : ajouté au client sans toucher à son e-mail principal ; pas de doublon", async () => {
    const t = await received("jeanne@atelier-bois.fr", "Jeanne Martin");
    const client = await createClient({ displayName: "Atelier Bois", type: "B2B" });
    await prisma.client.update({
      where: { id: client.id },
      data: { emailEncrypted: encrypt("compta@atelier-bois.fr"), emailHash: computeEmailHash("compta@atelier-bois.fr") },
    });

    const res = await call("POST", `/api/emails/${t.id}/link-client`, { clientId: client.id, addContact: true });
    expect(res.json().contactAdded).toBe(true);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(decryptOptional(after.emailEncrypted)).toBe("compta@atelier-bois.fr");
    const contacts = await prisma.clientContact.findMany({ where: { clientId: client.id }, orderBy: { position: "asc" } });
    expect(contacts.map((c) => [decryptOptional(c.emailEncrypted), c.isPrimary])).toEqual([
      ["compta@atelier-bois.fr", true],
      ["jeanne@atelier-bois.fr", false],
    ]);
    expect(contacts[1]).toMatchObject({ firstName: "Jeanne", lastName: "Martin" });

    // Deuxième association : l'adresse est déjà un contact.
    expect((await call("POST", `/api/emails/${t.id}/link-client`, { clientId: client.id, addContact: true })).json().contactAdded).toBe(false);
    expect(await prisma.clientContact.count({ where: { clientId: client.id } })).toBe(2);
  });

  it("404 : fil ou client inconnu ; 400 : corps invalide", async () => {
    const t = await received("jeanne@atelier-bois.fr", null);
    const client = await createClient({ displayName: "Atelier Bois" });
    expect((await call("POST", "/api/emails/inconnu/link-client", { clientId: client.id })).statusCode).toBe(404);
    expect((await call("POST", `/api/emails/${t.id}/link-client`, { clientId: "inconnu" })).statusCode).toBe(404);
    expect((await call("POST", `/api/emails/${t.id}/link-client`, {})).statusCode).toBe(400);
  });
});
