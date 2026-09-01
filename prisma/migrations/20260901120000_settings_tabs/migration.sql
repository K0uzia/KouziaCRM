-- AlterTable CompanySettings : onglets Paramètres (email IMAP, charte, Revolut Merchant, rappels acomptes)
ALTER TABLE "CompanySettings" ADD COLUMN "smtpEncryption" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpPassHint" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpFromName" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpReplyTo" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "emailThrottlePerMinute" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "CompanySettings" ADD COLUMN "imapHost" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapPort" INTEGER;
ALTER TABLE "CompanySettings" ADD COLUMN "imapSecure" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "imapUser" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapPassEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapPassHint" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "imapMailbox" TEXT NOT NULL DEFAULT 'INBOX';
ALTER TABLE "CompanySettings" ADD COLUMN "imapPollIntervalMinutes" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "CompanySettings" ADD COLUMN "attachmentMaxFileMb" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "CompanySettings" ADD COLUMN "attachmentMaxMessageMb" INTEGER NOT NULL DEFAULT 80;

ALTER TABLE "CompanySettings" ADD COLUMN "legalForm" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "rcsMention" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "vatIntraNumber" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "decennaleInsurer" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "decennalePolicyNumber" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "decennaleCoverageZone" TEXT;

ALTER TABLE "CompanySettings" ADD COLUMN "brandPrimaryColor" TEXT NOT NULL DEFAULT '#0f766e';
ALTER TABLE "CompanySettings" ADD COLUMN "brandSecondaryColor" TEXT NOT NULL DEFAULT '#0f172a';
ALTER TABLE "CompanySettings" ADD COLUMN "brandLogoPath" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "pdfFooterText" TEXT;

ALTER TABLE "CompanySettings" ADD COLUMN "revolutMerchantApiKeyEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "revolutMerchantApiKeyHint" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "revolutWebhookSecretEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "revolutWebhookSecretHint" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "revolutMerchantMode" TEXT NOT NULL DEFAULT 'sandbox';

ALTER TABLE "CompanySettings" ADD COLUMN "depositCount" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "CompanySettings" ADD COLUMN "depositPercent1Bps" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "CompanySettings" ADD COLUMN "depositPercent2Bps" INTEGER NOT NULL DEFAULT 4000;
ALTER TABLE "CompanySettings" ADD COLUMN "depositPercent3Bps" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "CompanySettings" ADD COLUMN "paymentButtonLeadDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "CompanySettings" ADD COLUMN "projectMilestoneMidBps" INTEGER NOT NULL DEFAULT 5000;

ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositMinus7Days" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositMinus1Days" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositPlus3Days" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositPlus10Days" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositMinus7Enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositMinus1Enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositPlus3Enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderDepositPlus10Enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SettingsAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "userEmail" TEXT,
    "tab" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "SettingsAuditLog_tab_createdAt_idx" ON "SettingsAuditLog"("tab", "createdAt");
CREATE INDEX "SettingsAuditLog_createdAt_idx" ON "SettingsAuditLog"("createdAt");
