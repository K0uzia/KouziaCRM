import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";
import { createFakeImap } from "../helpers/fake-imap.js";

// Aucune connexion IMAP réelle : la boîte est simulée en mémoire.
const PATHS = { INBOX: "\\Inbox", Trash: "\\Trash", Junk: "\\Junk" };
let imap = createFakeImap(PATHS);
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
const { listNotifications } = await import("@/lib/notifications/feed.js");
const { resetKnownDomainsCache } = await import("@/lib/email/spam.js");

let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  imap = createFakeImap(PATHS);
  resetKnownDomainsCache();
  await resetDb();
  await seedCompanySettings();
  const user = await prisma.user.upsert({
    where: { email: "admin-spam@kouzia.test" },
    update: {},
    create: { email: "admin-spam@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") },
  });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers: { cookie }, payload });
const body = (id: string) => app.inject({ method: "GET", url: `/api/emails/messages/${id}/body`, headers: { cookie } });

describe("indésirables", () => {
  it("signaler : le message part dans Junk sur le serveur, marqué lu et $Junk ; Pas indésirable le ramène", async () => {
    imap.deliver("INBOX", { messageId: "<promo@pub.test>", subject: "Promo", from: "promo@pub.test", date: new Date() });
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<promo@pub.test>" } });
    const inbox = await prisma.mailFolder.findFirstOrThrow({ where: { role: "INBOX" } });

    const res = await post("/api/emails/messages/report-spam", { messageIds: [message.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 1, kept: 0, restore: [{ id: message.id, folderId: inbox.id }] });
    const onServer = imap.find("Junk", "<promo@pub.test>");
    expect(onServer?.flags.has("$Junk")).toBe(true);
    expect(onServer?.flags.has("\\Seen")).toBe(true);
    expect(imap.find("INBOX", "<promo@pub.test>")).toBeUndefined();
    const local = await prisma.emailMessage.findUniqueOrThrow({ where: { id: message.id }, include: { folder: true } });
    expect(local.folder?.role).toBe("JUNK");
    expect(local.isRead).toBe(true);

    // La synchro suivante garde le message dans Indésirables, sans doublon.
    await runMailSync();
    expect(await prisma.emailMessage.count({ where: { messageId: "<promo@pub.test>" } })).toBe(1);

    const back = await post("/api/emails/messages/not-spam", { messageIds: [message.id] });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ moved: 1 });
    const returned = imap.find("INBOX", "<promo@pub.test>");
    expect(returned?.flags.has("$NotJunk")).toBe(true);
    expect(returned?.flags.has("$Junk")).toBe(false);
  });

  it("sans dossier Indésirables : 409, message laissé en place", async () => {
    imap = createFakeImap({ INBOX: "\\Inbox", Trash: "\\Trash" });
    imap.deliver("INBOX", { messageId: "<a@pub.test>", subject: "A", from: "a@pub.test", date: new Date() });
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<a@pub.test>" } });
    const res = await post("/api/emails/messages/report-spam", { messageIds: [message.id] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Indésirables introuvable/);
    expect(imap.find("INBOX", "<a@pub.test>")).toBeDefined();
  });

  it("entrée invalide : 400", async () => {
    expect((await post("/api/emails/messages/report-spam", { messageIds: [] })).statusCode).toBe(400);
  });

  it("un message rangé par le serveur dans Indésirables ne crée pas de notification", async () => {
    const since = new Date(Date.now() - 1000);
    imap.deliver("Junk", { messageId: "<spam@pub.test>", subject: "Gagnant", from: "x@pub.test", date: new Date() });
    imap.deliver("INBOX", { messageId: "<vrai@client.test>", subject: "Bonjour", from: "c@client.test", date: new Date() });
    await runMailSync();
    const subjects = (await listNotifications(since)).filter((n) => n.kind === "mail").map((n) => n.mail?.subject);
    expect(subjects).toEqual(["Bonjour"]);
  });

  it("bannière : DMARC en échec lu dans Authentication-Results, images bloquées pour un inconnu", async () => {
    imap.deliver("INBOX", {
      messageId: "<phish@banque.test>",
      subject: "Votre compte",
      from: "service@banque.test",
      date: new Date(),
      extraHeaders: "Authentication-Results: mx.kouzia.test;\r\n\tspf=fail smtp.mailfrom=banque.test;\r\n\tdmarc=fail header.from=banque.test",
      text: "Bonjour",
    });
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<phish@banque.test>" } });
    expect(message.rawHeaders).toMatch(/^Authentication-Results: mx\.kouzia\.test;/);
    expect(message.rawHeaders).not.toMatch(/Subject/);

    const res = await body(message.id);
    expect(res.statusCode).toBe(200);
    const security = res.json().security;
    expect(security.signals.map((s: { code: string }) => s.code)).toEqual(["dmarc_fail", "first_contact"]);
    expect(security.remoteImagesAllowed).toBe(false);
    expect(security.inJunk).toBe(false);
  });

  it("correspondant connu sans signal : images autorisées, pas de bannière", async () => {
    imap.deliver("INBOX", { messageId: "<ok@partenaire.test>", subject: "Suite", from: "p@partenaire.test", date: new Date(), text: "Merci" });
    await runMailSync();
    const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<ok@partenaire.test>" } });
    await prisma.emailMessage.create({
      data: {
        threadId: message.threadId,
        direction: "OUTBOUND",
        messageId: "<envoi@kouzia.local>",
        fromAddress: "contact@kouzia.test",
        toAddresses: JSON.stringify(["p@partenaire.test"]),
        subject: "Devis",
        receivedAt: new Date(Date.now() - 60_000),
      },
    });
    const security = (await body(message.id)).json().security;
    expect(security).toMatchObject({ signals: [], remoteImagesAllowed: true, inJunk: false });
  });
});
