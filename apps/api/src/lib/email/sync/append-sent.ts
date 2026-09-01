import { MailFolderRole } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";

/** Copie l'email envoyé dans le dossier Sent IMAP (webmail cohérent). */
export async function appendMessageToSentFolder(raw: Buffer): Promise<void> {
  const sentFolder = await prisma.mailFolder.findFirst({
    where: { role: MailFolderRole.SENT, isVirtual: false },
  });
  if (!sentFolder) return;

  await withImapClient(async ({ client }) => {
    await client.append(sentFolder.imapPath, raw, ["\\Seen"]);
  });
}
