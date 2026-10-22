-- Avant / après de la page projet (realisations[].detail.avantApres du site, validé le 23/10/2026) : 1 ou 2 paires de
-- captures (ordinateur, téléphone). Colonne ajoutée seulement, sans reprise de données.

-- AlterTable
ALTER TABLE "SiteProject" ADD COLUMN "avantApresJson" TEXT;
