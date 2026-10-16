-- Espace Site : textes alternatifs saisis dans l'ERP et publiés (contrat du site : imageAlt, logoAlt).
-- Null : le site garde son calcul (altCapture, nom de la structure) ; "" pour une capture : décorative.
-- Colonnes facultatives, aucune donnée modifiée ici.
ALTER TABLE "SiteProject" ADD COLUMN "imageAlt" TEXT;
ALTER TABLE "SiteReference" ADD COLUMN "logoAlt" TEXT;
