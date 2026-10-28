-- Devis en paiement unique avec maintenance en option, et ce qui est compris ou non (décisions d'Alexandre du 28/10/2026).
-- Additive : les lignes existantes ne sont pas en option (false), aucun choix ni périmètre n'est inventé pour les
-- devis déjà émis (null). Les nouvelles valeurs de LegalClauseKind (ONE_OFF_SCOPE, ONE_OFF_SCOPE_SOFTWARE) sont du
-- texte en SQLite : aucune colonne à changer.
ALTER TABLE "InvoiceLine" ADD COLUMN "isOptional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceLine" ADD COLUMN "optionalAccepted" BOOLEAN;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "optionalChoices" TEXT;
ALTER TABLE "QuoteOption" ADD COLUMN "scopeSnapshot" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "scopeSnapshot" TEXT;
