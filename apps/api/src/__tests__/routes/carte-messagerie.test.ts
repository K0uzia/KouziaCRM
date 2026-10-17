import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";
import { createFakeImap } from "../helpers/fake-imap.js";

// Aucune connexion IMAP réelle : la boîte est simulée en mémoire.
let imap = createFakeImap();
let imapDown = false;
vi.mock("@/lib/email/imap-config.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/imap-config.js")>()),
  isImapConfigured: async () => true,
}));
vi.mock("@/lib/email/sync/imap-connection.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/imap-connection.js")>()),
  withImapClient: async (fn: (ctx: { client: unknown; config: unknown }) => Promise<unknown>) => {
    if (imapDown) throw new Error("IMAP injoignable");
    return fn({ client: imap.client, config: {} });
  },
  disconnectImapClient: async () => {},
}));

const { buildApp } = await import("@/app.js");
const { runMailSync } = await import("@/lib/email/sync/index.js");

const ADMIN = "admin-carte@kouzia.test";
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
  imap = createFakeImap();
  imapDown = false;
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

async function card() {
  const o = (await get("/api/dashboard/overview?scope=month")).json();
  return o.mail as { unreadCount: number; messages: Array<{ id: string; subject: string; isRead: boolean }> };
}

/** Ce que l'écran Messagerie affiche à l'ouverture : Réception, puis filtre « Non lus ». */
async function messagerie() {
  const folders = (await get("/api/emails/folders")).json().folders as Array<{ id: string; role: string; unreadCount: number }>;
  const inbox = folders.find((f) => f.role === "INBOX")!;
  const list = (await get(`/api/emails/messages?folderId=${inbox.id}&take=5`)).json();
  const unread = (await get(`/api/emails/messages?folderId=${inbox.id}&unread=true`)).json();
  return { inbox, list, unreadTotal: unread.total as number };
}

function deliver(n: number, opts: { seen?: boolean } = {}) {
  for (let i = 0; i < n; i++) {
    imap.deliver("INBOX", {
      messageId: `<m${i}@exemple.test>`,
      subject: `Demande ${i}`,
      from: `exp${i}@exemple.test`,
      date: new Date(Date.UTC(2026, 9, 10, 9, i)),
      seen: opts.seen,
    });
  }
}

describe("carte Messagerie du tableau de bord", () => {
  it("même nombre et mêmes messages que l'écran Messagerie (Réception, non lus)", async () => {
    deliver(7);
    imap.deliver("Trash", { messageId: "<corbeille@exemple.test>", subject: "Jeté", from: "x@exemple.test", date: new Date() });
    await runMailSync();

    const c = await card();
    const m = await messagerie();
    expect(c.unreadCount).toBe(7);
    expect(c.unreadCount).toBe(m.unreadTotal);
    expect(c.unreadCount).toBe(m.inbox.unreadCount);
    expect((await get("/api/emails/sync-status")).json().inboxUnreadCount).toBe(7);
    expect(c.messages.map((x) => x.id)).toEqual(m.list.messages.map((x: { id: string }) => x.id));
    // Un message de la corbeille n'apparaît pas sur la carte.
    expect(c.messages.some((x) => x.subject === "Jeté")).toBe(false);
    expect((await get("/api/emails/inbox-summary")).json()).toEqual(c);
  });

  it("lu dans un autre client mail (\\Seen côté serveur) : la carte suit après la synchro", async () => {
    deliver(3);
    await runMailSync();
    expect((await card()).unreadCount).toBe(3);

    imap.setSeen("INBOX", "<m1@exemple.test>", true);
    await runMailSync();
    const c = await card();
    expect(c.unreadCount).toBe(2);
    expect(c.unreadCount).toBe((await messagerie()).unreadTotal);
    const thread = await prisma.emailThread.findFirstOrThrow({ where: { subject: "Demande 1" } });
    expect(thread.unreadCount).toBe(0);

    // Remis non lu ailleurs : compté de nouveau.
    imap.setSeen("INBOX", "<m1@exemple.test>", false);
    await runMailSync();
    expect((await card()).unreadCount).toBe(3);
  });

  it("supprimé ou déplacé côté serveur : retiré de la carte à la synchro suivante", async () => {
    deliver(3);
    await runMailSync();
    imap.remove("INBOX", "<m0@exemple.test>");
    imap.moveOnServer("INBOX", "<m2@exemple.test>", "Trash");
    await runMailSync();
    const c = await card();
    expect(c.unreadCount).toBe(1);
    expect(c.messages.map((x) => x.subject)).toEqual(["Demande 1"]);
    expect(c.unreadCount).toBe((await messagerie()).unreadTotal);
  });

  it("lu dans l'ERP : \\Seen écrit sur le serveur, la carte passe à 0", async () => {
    deliver(1);
    await runMailSync();
    const id = (await card()).messages[0]!.id;
    expect((await post("/api/emails/messages/bulk-flags", { messageIds: [id], read: true })).statusCode).toBe(200);
    expect(imap.find("INBOX", "<m0@exemple.test>")!.flags.has("\\Seen")).toBe(true);
    expect((await card()).unreadCount).toBe(0);
    await runMailSync();
    expect((await card()).unreadCount).toBe(0);
  });

  it("lu dans l'ERP pendant une panne IMAP : jamais remis non lu, \\Seen écrit à la synchro suivante", async () => {
    deliver(1);
    await runMailSync();
    const id = (await card()).messages[0]!.id;
    imapDown = true;
    await post("/api/emails/messages/bulk-flags", { messageIds: [id], read: true });
    imapDown = false;
    expect(imap.find("INBOX", "<m0@exemple.test>")!.flags.has("\\Seen")).toBe(false);
    await runMailSync();
    expect(imap.find("INBOX", "<m0@exemple.test>")!.flags.has("\\Seen")).toBe(true);
    expect((await card()).unreadCount).toBe(0);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id } })).flagsPending).toBe(false);
  });

  it("un fil reçu déjà lu ne compte pas comme non lu (compteur du fil exact à la création)", async () => {
    deliver(1, { seen: true });
    deliver(0);
    imap.deliver("INBOX", { messageId: "<nl@exemple.test>", subject: "Non lu", from: "n@exemple.test", date: new Date() });
    await runMailSync();
    const lu = await prisma.emailThread.findFirstOrThrow({ where: { subject: "Demande 0" } });
    const nonLu = await prisma.emailThread.findFirstOrThrow({ where: { subject: "Non lu" } });
    expect(lu.unreadCount).toBe(0);
    expect(nonLu.unreadCount).toBe(1);
  });
});

describe("formulaire du site (Web3Forms) rattaché au client", () => {
  async function clientWithEmail(email: string, name = "Camille Dupont") {
    const c = await createClient({ displayName: name, type: "B2C" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(email), emailHash: computeEmailHash(email) } });
    return c;
  }
  const corps = (email: string) =>
    ["nom : Camille Dupont", `email :  ${email}`, "telephone : 06 12 34 56 78", "structure : Association Les Étoiles", "projet : site vitrine", "message : Bonjour,", "un site pour l'association."].join("\n");

  function form(opts: { id: string; email: string; from?: string; replyTo?: string }) {
    imap.deliver("INBOX", {
      messageId: `<${opts.id}@web3forms.test>`,
      subject: "Nouveau message depuis kouzia.com",
      from: opts.from ?? "notify+abc123@web3forms.com",
      fromName: "Site Kouzia",
      replyTo: opts.replyTo,
      date: new Date(),
      text: corps(opts.email),
    });
  }
  async function threadOf(id: string) {
    const m = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: `<${id}@web3forms.test>` }, include: { thread: true } });
    return m;
  }

  it("adresse du corps : rattaché au client existant à la synchro, chaque formulaire dans son fil", async () => {
    const client = await clientWithEmail("camille@exemple.test");
    form({ id: "f1", email: "Camille@Exemple.test" });
    form({ id: "f2", email: "inconnu@exemple.test" });
    await runMailSync();
    const f1 = await threadOf("f1");
    const f2 = await threadOf("f2");
    expect(f1.thread.clientId).toBe(client.id);
    expect(f2.thread.clientId).toBeNull();
    expect(f1.threadId).not.toBe(f2.threadId);
  });

  it("aucun client : bouton « Créer le client » prérempli, rien de créé", async () => {
    form({ id: "f3", email: "nouvelle@exemple.test" });
    await runMailSync();
    const before = await prisma.client.count();
    const m = await threadOf("f3");
    const body = (await get(`/api/emails/messages/${m.id}/body`)).json();
    expect(body.formLead).toEqual({
      name: "Camille Dupont",
      email: "nouvelle@exemple.test",
      phone: "06 12 34 56 78",
      company: "Association Les Étoiles",
    });
    expect(await prisma.client.count()).toBe(before);
  });

  it("expéditeur hors web3forms.com : aucun rattachement par le corps", async () => {
    await clientWithEmail("camille@exemple.test");
    form({ id: "f4", email: "camille@exemple.test", from: "notify@web3forms.com.pirate.test" });
    await runMailSync();
    const m = await threadOf("f4");
    expect(m.thread.clientId).toBeNull();
    expect((await get(`/api/emails/messages/${m.id}/body`)).json().formLead).toBeNull();
  });

  it("Reply-To prioritaire sur la ligne « email : » du corps", async () => {
    const parReplyTo = await clientWithEmail("vrai@exemple.test", "Par Reply-To");
    await clientWithEmail("corps@exemple.test", "Par le corps");
    form({ id: "f5", email: "corps@exemple.test", replyTo: "vrai@exemple.test" });
    await runMailSync();
    expect((await threadOf("f5")).thread.clientId).toBe(parReplyTo.id);
  });
});
