import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailFolderRole } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

const discoverAndEnsureFolders = vi.fn(async () => {
  throw new Error("IMAP injoignable");
});
vi.mock("@/lib/email/sync/folder-sync.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/sync/folder-sync.js")>()),
  discoverAndEnsureFolders,
}));

const { getMailFoldersWithCounts } = await import("@/lib/email/sync/index.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  discoverAndEnsureFolders.mockClear();
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

  it("dossiers connus : servis depuis la base sans LIST IMAP, réception en tête", async () => {
    const account = await prisma.mailAccount.create({ data: { email: "contact@kouzia.test", isDefault: true } });
    for (const [imapPath, role] of [
      ["Trash", MailFolderRole.TRASH],
      ["Clients", MailFolderRole.CUSTOM],
      ["INBOX", MailFolderRole.INBOX],
      ["Sent", MailFolderRole.SENT],
    ] as const) {
      await prisma.mailFolder.create({ data: { accountId: account.id, imapPath, displayName: imapPath, role } });
    }
    const res = await getMailFoldersWithCounts();
    expect(discoverAndEnsureFolders).not.toHaveBeenCalled();
    expect(res.folders.map((f) => f.imapPath)).toEqual(["INBOX", "Sent", "Trash", "Clients"]);
  });

  it("aucun dossier en base : l'erreur IMAP remonte (écran « Boîte mail non connectée »)", async () => {
    await expect(getMailFoldersWithCounts()).rejects.toThrow("IMAP injoignable");
  });
});
