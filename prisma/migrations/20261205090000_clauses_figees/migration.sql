-- Clauses légales figées à l'émission d'un devis (instantané). null : brouillon ou devis émis avant cette migration.
-- TEXT et non JSONB : même type que les autres colonnes Json de "Invoice" (clientSnapshot, creditFollowUp).
ALTER TABLE "Invoice" ADD COLUMN "legalClausesSnapshot" TEXT;
