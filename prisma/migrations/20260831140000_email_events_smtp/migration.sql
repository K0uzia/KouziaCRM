-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN "smtpHost" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpPort" INTEGER;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpSecure" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpUser" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpPassEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "smtpFrom" TEXT;

-- CreateTable
CREATE TABLE "ClientEmailEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "documentId" TEXT,
    "documentNumber" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientEmailEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClientEmailEvent_clientId_sentAt_idx" ON "ClientEmailEvent"("clientId", "sentAt");
CREATE INDEX "ClientEmailEvent_documentId_idx" ON "ClientEmailEvent"("documentId");
