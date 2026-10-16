-- Espace Site : médiathèque. Nom lisible, original conservé (sans métadonnées) pour recadrer plus tard, point
-- d'intérêt du recadrage. Colonnes facultatives : les images déjà envoyées n'ont pas d'original, rien n'est modifié ici.
ALTER TABLE "SiteMedia" ADD COLUMN "label" TEXT;
ALTER TABLE "SiteMedia" ADD COLUMN "originalName" TEXT;
ALTER TABLE "SiteMedia" ADD COLUMN "originalPath" TEXT;
ALTER TABLE "SiteMedia" ADD COLUMN "originalBytes" INTEGER;
ALTER TABLE "SiteMedia" ADD COLUMN "focalX" REAL;
ALTER TABLE "SiteMedia" ADD COLUMN "focalY" REAL;
