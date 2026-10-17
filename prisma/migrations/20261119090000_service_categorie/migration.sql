-- Rubrique d'une prestation ponctuelle dans le catalogue (approuvé par Alexandre) : SITE, LOGICIEL ou OPTION.
-- null = « Autres » ; packs (isPack) et abonnements (isSubscription) ont leur rubrique propre, sans ce champ.
-- Colonne ajoutée seulement ; aucune donnée modifiée.
ALTER TABLE "Service" ADD COLUMN "category" TEXT;
