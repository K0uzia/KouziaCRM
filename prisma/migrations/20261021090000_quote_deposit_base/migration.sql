-- Devis : base de l'acompte et de l'échéancier (partie ponctuelle, hors abonnement), figée à l'émission (additif).
ALTER TABLE "Invoice" ADD COLUMN "depositBaseCents" INTEGER;
