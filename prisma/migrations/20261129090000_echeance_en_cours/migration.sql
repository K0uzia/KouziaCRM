-- Échéance de devis payée par prélèvement SEPA avant d'être facturée (validé le 20/10/2026) : état « en cours »
-- comme sur la facture, pour retirer le lien de paiement de /suivi pendant le prélèvement. Colonnes ajoutées seulement.

-- AlterTable
ALTER TABLE "PaymentMilestone" ADD COLUMN "paymentProcessingAt" DATETIME;
ALTER TABLE "PaymentMilestone" ADD COLUMN "paymentProcessingMethod" TEXT;
