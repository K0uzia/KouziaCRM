-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN "googleCalendarRefreshTokenEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "googleCalendarRefreshTokenHint" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "googleCalendarConnectedEmail" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "googleCalendarEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "obligationReminderEmail" TEXT NOT NULL DEFAULT 'kouziaeffa.pro@gmail.com';
ALTER TABLE "CompanySettings" ADD COLUMN "obligationEmailRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Obligation" ADD COLUMN "googleCalendarEventId" TEXT;

-- CreateTable
CREATE TABLE "ObligationReminderLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "obligationId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ObligationReminderLog_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "Obligation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ObligationReminderLog_obligationId_stage_key" ON "ObligationReminderLog"("obligationId", "stage");

-- CreateIndex
CREATE INDEX "ObligationReminderLog_sentAt_idx" ON "ObligationReminderLog"("sentAt");
