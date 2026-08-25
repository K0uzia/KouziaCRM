-- Legal clauses, INPI url, obligation attachments, URSSAF deadline default 15

ALTER TABLE "CompanySettings" ADD COLUMN "inpiUrl" TEXT;

-- Force legal URSSAF day to 15 for AE
UPDATE "CompanySettings" SET "urssafDeadlineDay" = 15;

CREATE TABLE "LegalClause" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "LegalClause_active_position_idx" ON "LegalClause"("active", "position");

ALTER TABLE "Obligation" ADD COLUMN "attachmentPath" TEXT;
ALTER TABLE "Obligation" ADD COLUMN "attachmentName" TEXT;
ALTER TABLE "Obligation" ADD COLUMN "attachmentMime" TEXT;
CREATE INDEX "Obligation_completedAt_idx" ON "Obligation"("completedAt");
