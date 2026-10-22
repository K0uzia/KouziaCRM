-- Fiches Réalisation (page projet /realisations/<slug>/ du site, validé le 22/10/2026) : textes détaillés, captures,
-- liens, client du projet et accord écrit de publication. Colonnes ajoutées seulement ; la clé étrangère est écrite à
-- la main : SQLite accepte ADD COLUMN avec REFERENCES quand la valeur par défaut est NULL.

-- AlterTable
ALTER TABLE "SiteProject" ADD COLUMN "descriptionText" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "contextText" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "needText" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "approachText" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "choicesText" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "resultText" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "clientIntro" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "clientName" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "capturesJson" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "linksJson" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "clientId" TEXT REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SiteProject" ADD COLUMN "publicationConsentAt" DATETIME;
ALTER TABLE "SiteProject" ADD COLUMN "publicationConsentNote" TEXT;
ALTER TABLE "SiteProject" ADD COLUMN "publicationConsentFile" TEXT;

-- CreateIndex
CREATE INDEX "SiteProject_clientId_idx" ON "SiteProject"("clientId");
