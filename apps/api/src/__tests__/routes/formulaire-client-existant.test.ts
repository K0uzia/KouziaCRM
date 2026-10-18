import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";
import { createFakeImap } from "../helpers/fake-imap.js";

// Aucune connexion IMAP réelle : la boîte est simulée en mémoire.
let imap = createFakeImap();
vi.mock("@/lib/email/imap-config.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/imap-config.js")>()),
  isImapConfigured: async () => true,
}));
vi.mock("@/lib/email/sync/imap-connection.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/imap-connection.js")>()),
  withImapClient: async (fn: (ctx: { client: unknown; config: unknown }) => Promise<unknown>) =>
    fn({ client: imap.client, config: {} }),
  disconnectImapClient: async () => {},
}));

const { buildApp } = await import("@/app.js");
const { runMailSync } = await import("@/lib/email/sync/index.js");

let app: FastifyInstance;
let cookie = "";
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  imap = createFakeImap();
  await resetDb();
  await seedCompanySettings();
  const user = await prisma.user.upsert({
    where: { email: "admin-formulaire@kouzia.test" },
    update: {},
    create: { email: "admin-formulaire@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") },
  });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

/** Corps texte du formulaire de kouzia.com tel que Web3Forms l'envoie (champs nommés par le formulaire). */
function formBody(email: string) {
  return [
    "nom : Camille Martin",
    `email : ${email}`,
    "telephone : 06 12 34 56 78",
    "structure : Atelier Martin",
    "projet : Site vitrine",
    "message : Bonjour, je reviens vers vous pour un second site.",
  ].join("\n");
}

async function existingClient(email: string) {
  return prisma.client.create({
    data: { displayName: "Camille Martin", type: "B2C", emailEncrypted: encrypt(email), emailHash: computeEmailHash(email) },
  });
}

function deliverForm(messageId: string, email: string, replyTo?: string) {
  imap.deliver("INBOX", {
    messageId,
    subject: "Nouvelle demande depuis kouzia.com",
    from: "notify+abc123@web3forms.com",
    fromName: "Site Kouzia",
    ...(replyTo ? { replyTo } : {}),
    date: new Date(),
    text: formBody(email),
  });
}

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

describe("formulaire du site : client existant reconnu dans la messagerie", () => {
  it.each([
    ["sans Reply-To", undefined],
    ["avec Reply-To", "camille.martin@exemple.fr"],
  ])("%s : message rattaché au client à la synchronisation, aucune proposition de création", async (_label, replyTo) => {
    const client = await existingClient("camille.martin@exemple.fr");
    deliverForm("<f1@web3forms.test>", "Camille.Martin@Exemple.fr", replyTo);
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<f1@web3forms.test>" }, include: { thread: true } });
    expect(message.thread.clientId).toBe(client.id);
    const body = (await get(`/api/emails/messages/${message.id}/body`)).json();
    expect(body.formLead ?? null).toBeNull();
  });

  it("fil ouvert : client, champs lisibles et réponse à l'adresse du client, jamais à Web3Forms", async () => {
    const client = await existingClient("camille.martin@exemple.fr");
    deliverForm("<f2@web3forms.test>", "Camille.Martin@Exemple.fr");
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<f2@web3forms.test>" } });
    const thread = (await get(`/api/emails/${message.threadId}`)).json();
    expect(thread.client).toMatchObject({ id: client.id, displayName: "Camille Martin" });
    expect(thread.formSubmission).toMatchObject({
      messageId: message.id,
      client: { id: client.id, displayName: "Camille Martin" },
      replyTo: "camille.martin@exemple.fr",
      fields: {
        name: "Camille Martin",
        email: "camille.martin@exemple.fr",
        phone: "06 12 34 56 78",
        company: "Atelier Martin",
        project: "Site vitrine",
        message: "Bonjour, je reviens vers vous pour un second site.",
      },
    });
    expect(JSON.stringify(thread.formSubmission)).not.toContain("web3forms");
  });

  it("aucun client : pas de fiche liée, champs pour préremplir « Créer le client », réponse à l'adresse saisie", async () => {
    deliverForm("<f3@web3forms.test>", "nouveau.prospect@exemple.fr");
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<f3@web3forms.test>" } });
    const thread = (await get(`/api/emails/${message.threadId}`)).json();
    expect(thread.client).toBeNull();
    expect(thread.formSubmission).toMatchObject({ client: null, replyTo: "nouveau.prospect@exemple.fr", fields: { name: "Camille Martin" } });
    const body = (await get(`/api/emails/messages/${message.id}/body`)).json();
    expect(body.formLead).toMatchObject({ name: "Camille Martin", email: "nouveau.prospect@exemple.fr", company: "Atelier Martin" });
  });

  it("message ordinaire : pas de bloc formulaire", async () => {
    imap.deliver("INBOX", { messageId: "<m1@exemple.test>", subject: "Bonjour", from: "quelqu.un@exemple.fr", date: new Date(), text: "email : x@y.fr" });
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<m1@exemple.test>" } });
    expect((await get(`/api/emails/${message.threadId}`)).json().formSubmission).toBeNull();
  });
});
