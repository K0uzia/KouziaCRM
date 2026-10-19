-- Durée d'engagement des abonnements (offre tout compris de 3 ans, décision du 19/10/2026). Colonnes ajoutées
-- seulement : null = sans engagement, comportement d'avant. La valeur SUBSCRIPTION_COMMITMENT de LegalClauseKind est
-- du texte en SQLite : rien à changer dans la base.

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN "commitmentMonths" INTEGER;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "commitmentMonths" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "commitmentEndsAt" DATETIME;
