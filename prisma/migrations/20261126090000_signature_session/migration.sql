-- Signature dans /suivi sans second code (décision du 19/10/2026) : méthode d'authentification de la preuve.
-- SIGN_CODE | PORTAL_SESSION ; null pour les preuves antérieures, toutes signées avec le code de signature.

-- AlterTable
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "authMethod" TEXT;
