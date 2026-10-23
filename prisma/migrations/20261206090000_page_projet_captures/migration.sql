-- Page projet (contrat du site, feat/etude-de-cas) : nature et durée du projet ; vue des captures dans capturesJson.
-- Médiathèque : recadrage d'une capture choisi à la main (null : format d'origine). Aucune donnée existante modifiée.
ALTER TABLE "SiteProject" ADD COLUMN "nature" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "duree" TEXT;
ALTER TABLE "SiteMedia" ADD COLUMN "cropRatio" TEXT;
