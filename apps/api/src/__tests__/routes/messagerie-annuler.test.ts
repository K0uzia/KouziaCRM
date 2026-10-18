import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
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

async function setup(uidplus: boolean) {
  imap = createFakeImap(undefined, { uidplus });
  await resetDb();
  await seedCompanySettings();
  const user = await prisma.user.upsert({
    where: { email: "admin-annuler@kouzia.test" },
    update: {},
    create: { email: "admin-annuler@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") },
  });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  // Corbeille déjà occupée : son uid 1 est celui qu'un uid périmé viserait.
  imap.deliver("Trash", { messageId: "<ancien@exemple.test>", subject: "Ancien", from: "a@exemple.test", date: new Date() });
  imap.deliver("INBOX", { messageId: "<jete@exemple.test>", subject: "Jeté", from: "b@exemple.test", date: new Date() });
  await runMailSync();
  const message = await prisma.emailMessage.findUniqueOrThrow({ where: { messageId: "<jete@exemple.test>" } });
  const inbox = await prisma.mailFolder.findFirstOrThrow({ where: { role: "INBOX" } });
  return { message, inbox };
}

const del = (id: string) => app.inject({ method: "DELETE", url: `/api/emails/messages/${id}`, headers: { cookie } });
const move = (id: string, folderId: string) =>
  app.inject({ method: "POST", url: `/api/emails/messages/${id}/move`, headers: { cookie }, payload: { folderId } });

beforeEach(() => {
  imap = createFakeImap();
});

describe("« Annuler » après une mise à la corbeille", () => {
  it("le message revient dans son dossier, sans toucher aux autres messages de la corbeille", async () => {
    const { message, inbox } = await setup(true);
    const trashed = await del(message.id);
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json().restoreFolderId).toBe(inbox.id);
    expect(imap.find("Trash", "<jete@exemple.test>")).toBeDefined();

    expect((await move(message.id, inbox.id)).statusCode).toBe(200);
    expect(imap.find("INBOX", "<jete@exemple.test>")).toBeDefined();
    expect(imap.find("Trash", "<jete@exemple.test>")).toBeUndefined();
    expect(imap.find("Trash", "<ancien@exemple.test>")).toBeDefined();
    const after = await prisma.emailMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.folderId).toBe(inbox.id);
    expect(after.imapUid).toBe(imap.find("INBOX", "<jete@exemple.test>")!.uid);
  });

  it("serveur sans UIDPLUS (uid périmé) : déplacement refusé, aucun autre message déplacé", async () => {
    const { message, inbox } = await setup(false);
    expect((await del(message.id)).statusCode).toBe(200);

    const res = await move(message.id, inbox.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/resynchronisé/);
    expect(imap.find("Trash", "<ancien@exemple.test>")).toBeDefined();
    expect(imap.find("INBOX", "<ancien@exemple.test>")).toBeUndefined();

    // Après le relevé, l'uid est à jour et « Annuler » aboutit.
    await runMailSync();
    expect((await move(message.id, inbox.id)).statusCode).toBe(200);
    expect(imap.find("INBOX", "<jete@exemple.test>")).toBeDefined();
  });

  it("suppression depuis la corbeille : définitive, rien à annuler", async () => {
    const { message } = await setup(true);
    await del(message.id);
    const res = await app.inject({ method: "DELETE", url: `/api/emails/messages/${message.id}`, headers: { cookie } });
    expect(res.json().restoreFolderId).toBeNull();
    expect(imap.find("Trash", "<jete@exemple.test>")).toBeUndefined();
  });
});
