-- Mode de facturation au niveau du devis (validé le 24/10/2026) : paiement unique (comptant, 2 ou 3 fois en parts
-- égales datées) ou récurrent (mensuel, trimestriel, annuel ; frais de mise en service possibles). Packs vendables dans
-- les deux modes : unitPriceCents devient le prix d'achat, annualPriceCents le prix annuel (vide = paiement unique
-- seulement). Colonnes ajoutées seulement : devis et packs existants inchangés. LegalClauseKind gagne
-- SUBSCRIPTION_QUARTERLY (enum stocké en texte par SQLite : aucun changement de structure).

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "billingMode" TEXT;

-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN "installmentIntervalDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "annualPriceCents" INTEGER;
