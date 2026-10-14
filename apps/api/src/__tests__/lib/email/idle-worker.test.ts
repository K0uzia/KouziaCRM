import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailFolderRole } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

/** Faux client imapflow : idle() reste ouvert tant qu'aucune commande ne l'interrompt, comme le vrai. */
class FakeImap extends EventEmitter {
  private endIdle: (() => void) | null = null;
  async mailboxOpen() {}
  idle() {
    return new Promise<void>((resolve) => {
      this.endIdle = resolve;
    });
  }
  async noop() {
    this.endIdle?.();
  }
  async logout() {}
}

const fake = new FakeImap();
const runMailSync = vi.fn(async () => ({ imported: 1, updated: 0, folders: 1 }));

vi.mock("@/lib/email/imap-config.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/imap-config.js")>()),
  isImapConfigured: async () => true,
}));
vi.mock("@/lib/email/sync/imap-connection.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/imap-connection.js")>()),
  getImapClient: async () => ({ client: fake, config: {} }),
  disconnectImapClient: async () => {},
}));
vi.mock("@/lib/email/sync/index.js", () => ({ runMailSync }));

const { startIdleWorker, stopIdleWorker, runMailPollFallback, FALLBACK_STALE_MS } = await import(
  "@/lib/email/sync/idle-worker.js"
);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  runMailSync.mockClear();
});

afterEach(() => {
  stopIdleWorker();
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("délai dépassé");
}

describe("synchro automatique de la messagerie", () => {
  it("IDLE : un nouveau message (EXISTS) déclenche la synchro, sans clic", async () => {
    const account = await prisma.mailAccount.create({ data: { email: "contact@kouzia.test", isDefault: true } });
    await prisma.mailFolder.create({
      data: { accountId: account.id, imapPath: "INBOX", displayName: "Réception", role: MailFolderRole.INBOX },
    });
    await startIdleWorker();
    await waitFor(async () => (await prisma.mailSyncStatus.findUnique({ where: { id: "default" } }))?.idleActive === true);

    fake.emit("exists", { path: "INBOX", count: 9, prevCount: 8 });
    await waitFor(() => runMailSync.mock.calls.length > 0);
    expect(runMailSync).toHaveBeenCalledTimes(1);
  });

  it("repli : IDLE actif mais muet depuis plus de 2 min, la synchro part quand même", async () => {
    const now = Date.now();
    await prisma.mailSyncStatus.create({
      data: { id: "default", idleActive: true, connected: true, lastSyncAt: new Date(now - FALLBACK_STALE_MS - 1000) },
    });
    expect(await runMailPollFallback(now)).toBe("synced");
    expect(runMailSync).toHaveBeenCalledTimes(1);
  });

  it("repli : IDLE actif et synchro récente, rien à faire", async () => {
    const now = Date.now();
    await prisma.mailSyncStatus.create({
      data: { id: "default", idleActive: true, connected: true, lastSyncAt: new Date(now - 30_000) },
    });
    expect(await runMailPollFallback(now)).toBe("skipped");
    expect(runMailSync).not.toHaveBeenCalled();
  });

  it("IDLE : connexion coupée par le serveur, l'état passe hors ligne puis IDLE reprend", async () => {
    const account = await prisma.mailAccount.create({ data: { email: "contact@kouzia.test", isDefault: true } });
    await prisma.mailFolder.create({
      data: { accountId: account.id, imapPath: "INBOX", displayName: "Réception", role: MailFolderRole.INBOX },
    });
    const status = () => prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
    await startIdleWorker();
    await waitFor(async () => (await status())?.idleActive === true);

    fake.emit("close");
    await waitFor(async () => (await status())?.lastError === "Connexion IMAP fermée pendant IDLE");
    expect((await status())?.idleActive).toBe(false);
    // Reconnexion après le premier palier de backoff (1 s).
    await waitFor(async () => (await status())?.idleActive === true);
  });
});
