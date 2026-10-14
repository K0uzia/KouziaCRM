-- Espace Site, lot E2.1 : migration additive écrite à la main (Prisma proposait de redéfinir les tables).
-- SQLite accepte ADD COLUMN avec REFERENCES quand la valeur par défaut est NULL.

-- Avis (L111-7-2 et D111-17 du Code de la consommation) : date de l'expérience, preuve de la relation
-- client (jamais publiée), texte retouché avec l'accord de l'auteur.
ALTER TABLE "SiteReview" ADD COLUMN "experienceOn" TEXT;
ALTER TABLE "SiteReview" ADD COLUMN "clientId" TEXT REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SiteReview" ADD COLUMN "invoiceId" TEXT REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SiteReview" ADD COLUMN "alteredWithConsent" BOOLEAN NOT NULL DEFAULT false;

-- Références (mur de logos) : emplacements sur le site.
ALTER TABLE "SiteReference" ADD COLUMN "onHome" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SiteReference" ADD COLUMN "onProjects" BOOLEAN NOT NULL DEFAULT false;

-- Jeton GitHub : date du dernier test réussi (sans elle, « sans date d'expiration » et « jamais testé »
-- s'affichaient pareil).
ALTER TABLE "CompanySettings" ADD COLUMN "githubTokenCheckedAt" DATETIME;
