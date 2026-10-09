-- Espace client : connexion par code e-mail (remplace numéro client + code d'accès)
CREATE TABLE "PortalCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "quoteId" TEXT,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortalCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PortalCode_clientId_purpose_createdAt_idx" ON "PortalCode"("clientId", "purpose", "createdAt");

CREATE TABLE "PortalSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    CONSTRAINT "PortalSession_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PortalSession_tokenHash_key" ON "PortalSession"("tokenHash");
CREATE INDEX "PortalSession_clientId_idx" ON "PortalSession"("clientId");

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "emailVerifiedAt" DATETIME;
ALTER TABLE "Client" DROP COLUMN "accessCodeHash";
ALTER TABLE "Client" DROP COLUMN "accessCodeEncrypted";

-- AlterTable
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "signatureMode" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "signatureImage" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "signerCompany" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "verifiedEmailMasked" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "codeVerifiedAt" DATETIME;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "originalPdfPath" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "originalPdfSha256" TEXT;
