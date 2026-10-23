-- Mise en avant d'une réalisation sur l'accueil du site (realisations.json : miseEnAvant, écrit seulement à true, 3 au plus).
-- Migration additive : toutes les réalisations existantes restent non mises en avant.
ALTER TABLE "SiteProject" ADD COLUMN "featuredOnHome" BOOLEAN NOT NULL DEFAULT false;
