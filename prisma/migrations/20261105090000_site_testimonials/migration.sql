-- Témoignages déposés par les clients depuis leur espace (/suivi) en fin de projet. Additive, écrite à
-- la main : SQLite accepte ADD COLUMN avec REFERENCES quand la valeur par défaut est NULL.
ALTER TABLE "SiteReview" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "SiteReview" ADD COLUMN "projectId" TEXT REFERENCES "ClientProject" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SiteReview" ADD COLUMN "authorFormat" TEXT;
ALTER TABLE "SiteReview" ADD COLUMN "rejectedAt" DATETIME;
ALTER TABLE "SiteReview" ADD COLUMN "rejectionReason" TEXT;
-- Un seul témoignage par projet (plusieurs NULL restent permis : témoignages saisis à la main).
CREATE UNIQUE INDEX "SiteReview_projectId_key" ON "SiteReview"("projectId");
