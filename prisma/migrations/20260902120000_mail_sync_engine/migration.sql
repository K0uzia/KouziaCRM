-- Mail sync engine: MailAccount, MailFolder, extended EmailMessage/EmailThread, settings

-- CreateTable MailAccount
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "imapHost" TEXT,
    "smtpHost" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable MailFolder
CREATE TABLE "MailFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "imapPath" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CUSTOM',
    "uidValidity" INTEGER NOT NULL DEFAULT 0,
    "highestUid" INTEGER NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "isVirtual" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MailFolder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MailAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MailFolder_accountId_imapPath_key" ON "MailFolder"("accountId", "imapPath");
CREATE INDEX "MailFolder_accountId_role_idx" ON "MailFolder"("accountId", "role");

-- CreateTable MailSyncStatus
CREATE TABLE "MailSyncStatus" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "idleActive" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "lastSyncAt" DATETIME,
    "reconnectAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "MailSyncStatus" ("id", "connected", "idleActive", "updatedAt") VALUES ('default', false, false, CURRENT_TIMESTAMP);

-- AlterTable CompanySettings
ALTER TABLE "CompanySettings" ADD COLUMN "imapFolderInbox" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapFolderSent" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapFolderDrafts" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapFolderTrash" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapFolderJunk" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapFolderArchive" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "emailSignatureHtml" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "emailBrowserNotifications" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable EmailThread
ALTER TABLE "EmailThread" ADD COLUMN "unreadCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EmailThread" ADD COLUMN "isStarred" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "EmailThread_isStarred_idx" ON "EmailThread"("isStarred");

-- AlterTable EmailMessage
ALTER TABLE "EmailMessage" ADD COLUMN "folderId" TEXT REFERENCES "MailFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD COLUMN "referencesHeader" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "ccAddresses" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "snippet" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "bodyFetched" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailMessage" ADD COLUMN "isStarred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailMessage" ADD COLUMN "hasAttachments" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailMessage" ADD COLUMN "imapUid" INTEGER;
ALTER TABLE "EmailMessage" ADD COLUMN "orphaned" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "EmailMessage_folderId_imapUid_idx" ON "EmailMessage"("folderId", "imapUid");
CREATE INDEX "EmailMessage_isRead_idx" ON "EmailMessage"("isRead");
CREATE INDEX "EmailMessage_isStarred_idx" ON "EmailMessage"("isStarred");

-- Migrate EmailSyncState -> MailFolder (best effort after account bootstrap in app)
UPDATE "EmailMessage" SET "bodyFetched" = true WHERE "bodyText" IS NOT NULL OR "bodyHtml" IS NOT NULL;
