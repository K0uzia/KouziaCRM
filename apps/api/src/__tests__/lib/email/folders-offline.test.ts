import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailFolderRole } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/sync/folder-sync.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/folder-sync.js")>()),
  discoverAndEnsureFolders: async () => {
    throw new Error("IMAP injoignable");
  },
}));

const { getMailFoldersWithCounts } = await import("@/lib/email/sync/index.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

describe("messagerie sans connexion IMAP", () => {
  it("les dossiers déjà synchronisés restent consultables", async () => {
    const account = await prisma.mailAccount.create({ data: { email: "contact@kouzia.test", isDefault: true } });
    await prisma.mailFolder.create({
      data: { accountId: account.id, imapPath: "INBOX", displayName: "INBOX", role: MailFolderRole.INBOX, unreadCount: 2 },
    });
    const res = await getMailFoldersWithCounts();
    expect(res.folders.map((f) => f.imapPath)).toEqual(["INBOX"]);
    expect(res.folders[0]!.unreadCount).toBe(2);
  });

  it("aucun dossier en base : l'erreur IMAP remonte (écran « Boîte mail non connectée »)", async () => {
    await expect(getMailFoldersWithCounts()).rejects.toThrow("IMAP injoignable");
  });
});
