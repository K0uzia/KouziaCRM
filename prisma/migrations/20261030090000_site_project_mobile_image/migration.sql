-- Capture de téléphone facultative des réalisations (imageMobile du contrat du site). Additive : une colonne NULL.
-- La valeur MOBILE de SiteMediaKind n'exige rien en SQLite (enum stocké en TEXT).
ALTER TABLE "SiteProject" ADD COLUMN "imageMobilePath" TEXT;
