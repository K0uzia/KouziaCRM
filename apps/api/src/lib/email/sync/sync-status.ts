import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";

export async function updateMailSyncStatus(patch: {
  connected?: boolean;
  idleActive?: boolean;
  lastError?: string | null;
  lastSyncAt?: Date | null;
  reconnectAt?: Date | null;
}) {
  return prisma.mailSyncStatus.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      connected: patch.connected ?? false,
      idleActive: patch.idleActive ?? false,
      lastError: patch.lastError ?? null,
      lastSyncAt: patch.lastSyncAt ?? null,
      reconnectAt: patch.reconnectAt ?? null,
    },
    update: patch,
  });
}

export async function getMailSyncStatus() {
  return prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
}

export async function ensureMailAccount() {
  const settings = await getCompanySettings();
  const email =
    settings.smtpFrom?.trim() ||
    settings.imapUser?.trim() ||
    "contact@kouzia.com";

  const existing = await prisma.mailAccount.findFirst({
    where: { isDefault: true },
  });
  if (existing) {
    const hostChanged =
      Boolean(existing.imapHost) &&
      Boolean(settings.imapHost) &&
      existing.imapHost !== settings.imapHost;
    if (hostChanged) {
      await prisma.emailMessage.updateMany({
        where: { folder: { accountId: existing.id } },
        data: { orphaned: true, imapUid: null },
      });
      await prisma.mailFolder.updateMany({
        where: { accountId: existing.id },
        data: { highestUid: 0, uidValidity: 0, unreadCount: 0 },
      });
    }
    return prisma.mailAccount.update({
      where: { id: existing.id },
      data: {
        email,
        imapHost: settings.imapHost ?? null,
        smtpHost: settings.smtpHost ?? null,
      },
    });
  }

  return prisma.mailAccount.create({
    data: {
      email,
      label: settings.tradeName ?? settings.legalName,
      isDefault: true,
      imapHost: settings.imapHost ?? null,
      smtpHost: settings.smtpHost ?? null,
    },
  });
}
