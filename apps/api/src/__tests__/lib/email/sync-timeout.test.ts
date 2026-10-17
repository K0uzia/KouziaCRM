import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

let hang = true;
const disconnectImapClient = vi.fn(async () => {});

vi.mock("@/lib/email/imap-config.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/imap-config.js")>()),
  isImapConfigured: async () => true,
}));
vi.mock("@/lib/email/sync/imap-connection.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/imap-connection.js")>()),
  disconnectImapClient,
}));
vi.mock("@/lib/email/sync/folder-sync.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/folder-sync.js")>()),
  // Socket à demi coupée : la commande IMAP ne répond jamais.
  syncAllFolders: () =>
    hang ? new Promise(() => {}) : Promise.resolve({ imported: 0, updated: 0, folders: 1 }),
  pollFlagChanges: async () => {},
}));

const { runMailSync } = await import("@/lib/email/sync/index.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  disconnectImapClient.mockClear();
  hang = true;
});

describe("synchro de la messagerie bloquée", () => {
  it("un passage sans réponse est abandonné, la connexion fermée et l'erreur visible", async () => {
    await expect(runMailSync(50)).rejects.toThrow("Synchronisation bloquée");
    expect(disconnectImapClient).toHaveBeenCalled();
    const status = await prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
    expect(status?.connected).toBe(false);
    expect(status?.lastError).toMatch(/bloquée/);
  });

  it("la synchro suivante repart et met lastSyncAt à jour, même sans nouveau message", async () => {
    await expect(runMailSync(50)).rejects.toThrow();
    hang = false;
    // Passage normal : délai large (la suite complète charge la base en parallèle), seul le blocage est testé à 50 ms.
    const result = await runMailSync(5000);
    expect(result.imported).toBe(0);
    const status = await prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
    expect(status?.connected).toBe(true);
    expect(status?.lastError).toBeNull();
    expect(status?.lastSyncAt).toBeInstanceOf(Date);
  });
});
