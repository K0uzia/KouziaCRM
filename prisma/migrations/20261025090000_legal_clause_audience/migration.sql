-- Clause légale réservée à un type de client (additif).
ALTER TABLE "LegalClause" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'ALL';
-- Pénalités de retard et indemnité forfaitaire de 40 € (L441-10, D441-5 du code de commerce) :
-- relations entre professionnels seulement. Le texte de la clause n'est pas modifié.
UPDATE "LegalClause" SET "audience" = 'B2B' WHERE "kind" = 'PENALTY';
-- Particuliers : mention de retard par défaut, seulement si aucune clause de retard ne les vise déjà.
-- Modifiable ou supprimable dans les réglages (elle n'est pas recréée ensuite).
INSERT INTO "LegalClause" ("id", "kind", "title", "body", "required", "active", "position", "audience", "createdAt", "updatedAt")
SELECT 'legal_penalty_b2c_default', 'PENALTY', 'Retard de paiement (particuliers)',
       'En cas de retard de paiement, des intérêts au taux légal pourront être appliqués après mise en demeure (article 1231-6 du Code civil).',
       false, true, 2, 'B2C', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "LegalClause")
  AND NOT EXISTS (SELECT 1 FROM "LegalClause" WHERE "kind" = 'PENALTY' AND "audience" = 'B2C');
