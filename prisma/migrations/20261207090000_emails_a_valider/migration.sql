-- File « E-mails à valider » (E6) : tout e-mail automatique au client attend la validation de l'admin (statut REVIEW),
-- sauf les familles validées d'office dans les Réglages. Nouvelles valeurs d'EmailOutboxStatus (REVIEW, REJECTED) :
-- stockées en TEXT sous SQLite, aucune modification de table. Migration additive, aucune donnée existante modifiée.
ALTER TABLE "EmailOutbox" ADD COLUMN "origin" TEXT;
ALTER TABLE "EmailOutbox" ADD COLUMN "reviewFamily" TEXT;
ALTER TABLE "EmailOutbox" ADD COLUMN "reviewKind" TEXT;
ALTER TABLE "EmailOutbox" ADD COLUMN "documentId" TEXT;
ALTER TABLE "EmailOutbox" ADD COLUMN "clientWaiting" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailOutbox" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "EmailOutbox" ADD COLUMN "rejectReason" TEXT;
ALTER TABLE "EmailOutbox" ADD COLUMN "reviewReminderAt" DATETIME;
CREATE INDEX "EmailOutbox_status_createdAt_idx" ON "EmailOutbox"("status", "createdAt");
CREATE INDEX "EmailOutbox_documentId_status_idx" ON "EmailOutbox"("documentId", "status");
ALTER TABLE "CompanySettings" ADD COLUMN "emailAutoApproveKinds" TEXT NOT NULL DEFAULT '[]';
