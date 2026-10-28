import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";
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
const { matchRule } = await import("@/lib/email/sender-rules.js");
const { encrypt } = await import("@/lib/crypto.js");
const { computeEmailHash } = await import("@/lib/clients/email-hash.js");

async function clientWithEmail(email: string) {
  const c = await createClient();
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(email), emailHash: computeEmailHash(email) } });
  return c;
}

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
  await resetDb();
  await seedCompanySettings();
  const user = await prisma.user.upsert({
    where: { email: "admin-regles@kouzia.test" },
    update: {},
    create: { email: "admin-regles@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") },
  });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload });
const addRule = (payload: Record<string, unknown>) => post("/api/emails/sender-rules", payload);

describe("règles d'expéditeur", () => {
  it("bloquer par adresse ou par domaine ; refus pour une messagerie grand public et le domaine de l'entreprise", async () => {
    const byAddress = await addRule({ kind: "ADDRESS", action: "BLOCK", value: " Promo@Pub.TEST " });
    expect(byAddress.statusCode).toBe(200);
    expect(byAddress.json()).toMatchObject({ kind: "ADDRESS", value: "promo@pub.test", action: "BLOCK" });

    expect((await addRule({ kind: "DOMAIN", action: "BLOCK", value: "@arnaque.test" })).json()).toMatchObject({
      value: "arnaque.test",
    });
    for (const value of ["gmail.com", "yahoo.fr", "hotmail.co.uk", "orange.fr", "proton.me"]) {
      const res = await addRule({ kind: "DOMAIN", action: "BLOCK", value });
      expect(res.statusCode, value).toBe(400);
      expect(res.json().error).toMatch(/grand public/);
    }
    // Faire confiance à tout gmail.com est refusé aussi.
    expect((await addRule({ kind: "DOMAIN", action: "TRUST", value: "gmail.com" })).statusCode).toBe(400);

    await prisma.mailAccount.create({ data: { email: "contact@kouzia-entreprise.test", isDefault: true } });
    const own = await addRule({ kind: "DOMAIN", action: "BLOCK", value: "kouzia-entreprise.test" });
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toMatch(/domaine de votre entreprise/);

    expect((await addRule({ kind: "ADDRESS", action: "BLOCK", value: "pas-une-adresse" })).statusCode).toBe(400);
    expect((await addRule({ kind: "ADDRESS", action: "BLOCK", value: "x@web3forms.com" })).statusCode).toBe(400);

    const list = await app.inject({ method: "GET", url: "/api/emails/sender-rules", headers: { cookie } });
    expect(list.json().map((r: { value: string }) => r.value).sort()).toEqual(["arnaque.test", "promo@pub.test"]);

    const del = await app.inject({ method: "DELETE", url: `/api/emails/sender-rules/${byAddress.json().id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(await prisma.mailSenderRule.count()).toBe(1);
  });

  it("l'adresse d'un client ne peut pas être bloquée", async () => {
    await clientWithEmail("camille@client-reel.test");
    const res = await addRule({ kind: "ADDRESS", action: "BLOCK", value: "camille@client-reel.test" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/client/);
  });

  it("une même valeur change d'action au lieu d'être en double ; TRUST l'emporte sur un blocage de domaine", async () => {
    await addRule({ kind: "ADDRESS", action: "BLOCK", value: "ami@partenaire.test" });
    await addRule({ kind: "ADDRESS", action: "TRUST", value: "ami@partenaire.test" });
    expect(await prisma.mailSenderRule.count()).toBe(1);
    await addRule({ kind: "DOMAIN", action: "BLOCK", value: "partenaire.test" });
    const rules = await prisma.mailSenderRule.findMany();
    expect(matchRule(rules, "ami@partenaire.test")?.action).toBe("TRUST");
    expect(matchRule(rules, "autre@mail.partenaire.test")?.action).toBe("BLOCK");
    expect(matchRule(rules, "x@ailleurs.test")).toBeNull();
  });

  it("synchro : message d'un expéditeur bloqué rangé dans Indésirables, lu, sans notification ; compteur tenu", async () => {
    const since = new Date(Date.now() - 1000);
    const rule = (await addRule({ kind: "DOMAIN", action: "BLOCK", value: "arnaque.test" })).json();
    await clientWithEmail("boss@arnaque.test");
    imap.deliver("INBOX", { messageId: "<b1@arnaque.test>", subject: "Bloqué", from: "x@arnaque.test", date: new Date() });
    imap.deliver("INBOX", { messageId: "<c1@arnaque.test>", subject: "Client", from: "boss@arnaque.test", date: new Date() });
    imap.deliver("INBOX", { messageId: "<ok@ailleurs.test>", subject: "Normal", from: "y@ailleurs.test", date: new Date() });
    await runMailSync();

    expect(imap.find("Junk", "<b1@arnaque.test>")?.flags.has("\\Seen")).toBe(true);
    expect(imap.find("INBOX", "<b1@arnaque.test>")).toBeUndefined();
    // Un client passe toujours, même sur un domaine bloqué.
    expect(imap.find("INBOX", "<c1@arnaque.test>")).toBeDefined();
    const blocked = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<b1@arnaque.test>" }, include: { folder: true } });
    expect(blocked.folder?.role).toBe("JUNK");
    expect(blocked.isRead).toBe(true);

    const subjects = (await listNotifications(since)).filter((n) => n.kind === "mail").map((n) => n.mail?.subject).sort();
    expect(subjects).toEqual(["Client", "Normal"]);
    const after = await prisma.mailSenderRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(after.hitCount).toBe(1);
    expect(after.lastHitAt).not.toBeNull();
  });

  it("sans dossier Indésirables : le message bloqué reste en Réception, lu et sans notification", async () => {
    imap = createFakeImap({ INBOX: "\\Inbox", Trash: "\\Trash" });
    const since = new Date(Date.now() - 1000);
    await addRule({ kind: "ADDRESS", action: "BLOCK", value: "x@arnaque.test" });
    imap.deliver("INBOX", { messageId: "<b2@arnaque.test>", subject: "Bloqué", from: "x@arnaque.test", date: new Date() });
    await runMailSync();
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<b2@arnaque.test>" } })).isRead).toBe(true);
    expect((await listNotifications(since)).filter((n) => n.kind === "mail")).toEqual([]);
  });

  it("signaler avec « Bloquer aussi cet expéditeur » crée une règle ; sans la case, aucune", async () => {
    imap.deliver("INBOX", { messageId: "<s1@pub.test>", subject: "A", from: "a@pub.test", date: new Date() });
    imap.deliver("INBOX", { messageId: "<s2@pub.test>", subject: "B", from: "b@pub.test", date: new Date() });
    await runMailSync();
    const a = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<s1@pub.test>" } });
    const b = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<s2@pub.test>" } });

    expect((await post("/api/emails/messages/report-spam", { messageIds: [a.id] })).json()).toMatchObject({ blocked: 0 });
    expect(await prisma.mailSenderRule.count()).toBe(0);

    const res = await post("/api/emails/messages/report-spam", { messageIds: [b.id], blockSender: true });
    expect(res.json()).toMatchObject({ moved: 1, blocked: 1 });
    expect(await prisma.mailSenderRule.findFirst()).toMatchObject({ kind: "ADDRESS", value: "b@pub.test", action: "BLOCK", source: "REPORT" });
  });

  it("depuis un message : règle sur l'expéditeur réel ; corps : règle et domaine proposés, confiance = images chargées", async () => {
    imap.deliver("INBOX", { messageId: "<n1@nouveau.test>", subject: "Bonjour", from: "n@nouveau.test", date: new Date(), text: "Salut" });
    await runMailSync();
    const m = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<n1@nouveau.test>" } });
    const body = async () =>
      (await app.inject({ method: "GET", url: `/api/emails/messages/${m.id}/body`, headers: { cookie } })).json().security;

    expect((await body()).sender).toMatchObject({ address: "n@nouveau.test", domain: "nouveau.test", isClient: false, rule: null });
    expect((await body()).remoteImagesAllowed).toBe(false);

    const res = await addRule({ kind: "ADDRESS", action: "TRUST", messageId: m.id });
    expect(res.json()).toMatchObject({ value: "n@nouveau.test", action: "TRUST" });
    const sec = await body();
    expect(sec.sender.rule).toMatchObject({ action: "TRUST", kind: "ADDRESS" });
    expect(sec.remoteImagesAllowed).toBe(true);
  });
});
