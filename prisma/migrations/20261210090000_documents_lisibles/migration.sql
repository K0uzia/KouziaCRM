-- Version lisible des documents (contrat B avec le site, RGAA 13.3) : JSON figé avec le PDF archivé.
-- Migration additive : NULL pour l'existant, rattrapé par le worker seulement si le texte correspond au PDF archivé.
ALTER TABLE "Invoice" ADD COLUMN "readableSnapshot" TEXT;
ALTER TABLE "Payment" ADD COLUMN "receiptReadableSnapshot" TEXT;
