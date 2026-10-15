-- CGV (lot L2, L3) et droit de rétractation des particuliers : colonnes ajoutées seulement.
-- Les nouvelles valeurs de LegalClauseKind n'ont pas de SQL (enum stocké en TEXT sous SQLite) ;
-- les clauses par défaut sont créées par ensureDefaultLegalClauses.
ALTER TABLE "CompanySettings" ADD COLUMN "cgvPublished" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "cgvUrl" TEXT DEFAULT 'https://kouzia.com/cgv';
ALTER TABLE "CompanySettings" ADD COLUMN "cgvVersion" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "withdrawalExpressRequestText" TEXT NOT NULL DEFAULT 'Je demande que la prestation commence avant la fin du délai de rétractation de 14 jours. Si je me rétracte ensuite, je paierai un montant proportionnel à ce qui aura été fourni jusqu''à ma rétractation. Si la prestation est entièrement exécutée avant la fin de ce délai, je perds mon droit de rétractation.';
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "cgvAccepted" BOOLEAN;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "cgvUrl" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "cgvVersion" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "consumer" BOOLEAN;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "expressExecution" BOOLEAN;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "withdrawalEndsAt" DATETIME;
