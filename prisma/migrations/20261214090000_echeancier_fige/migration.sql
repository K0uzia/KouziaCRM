-- Lot D (audit des documents du 25/10/2026), additive.
-- Réglages d'échéancier figés à l'émission du devis (JSON, comme legalClausesSnapshot) : null = réglages actuels.
ALTER TABLE "Invoice" ADD COLUMN "paymentScheduleSnapshot" TEXT;
