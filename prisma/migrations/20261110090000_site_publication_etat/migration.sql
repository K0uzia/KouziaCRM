-- Espace Site : état de publication par élément (Brouillon, Nouveau, Modifié, Publié, retrait à publier) calculé
-- dans l'ERP, sans GitHub. Colonnes facultatives : remplies à la publication suivante, aucune donnée modifiée ici.
ALTER TABLE "SiteProject" ADD COLUMN "publishedHash" TEXT;
ALTER TABLE "SiteReview" ADD COLUMN "publishedHash" TEXT;
ALTER TABLE "SiteReference" ADD COLUMN "publishedHash" TEXT;
ALTER TABLE "SiteFaq" ADD COLUMN "publishedHash" TEXT;
ALTER TABLE "SiteText" ADD COLUMN "publishedHash" TEXT;
-- Fichiers publiés (détail des changements, historique) ; rétention : 50 dernières publications complètes.
ALTER TABLE "SitePublication" ADD COLUMN "filesJson" TEXT;
