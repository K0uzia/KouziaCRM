-- Rattrapage de la dérive entre les migrations et schema.prisma, sans reconstruction de table.
-- Index déclaré dans le schéma mais créé par aucune migration.
CREATE INDEX IF NOT EXISTS "MailAccount_isDefault_idx" ON "MailAccount"("isDefault");
-- Ancienne répartition par défaut des acomptes (3 acomptes 30/40/30), corrigée seulement à sa valeur
-- exacte : une répartition choisie dans les réglages n'est jamais modifiée.
UPDATE "CompanySettings"
SET "depositCount" = 2, "depositPercent2Bps" = 7000, "depositPercent3Bps" = 0
WHERE "depositCount" = 3 AND "depositPercent1Bps" = 3000 AND "depositPercent2Bps" = 4000 AND "depositPercent3Bps" = 3000;
