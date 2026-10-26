-- Mentions légales (26/10/2026), additive : une clause supprimée est gardée (deletedAt) pour qu'une clause par défaut
-- ne soit jamais recréée au chargement de la liste ; elle est aussi inactive, donc jamais imprimée.
ALTER TABLE "LegalClause" ADD COLUMN "deletedAt" DATETIME;
