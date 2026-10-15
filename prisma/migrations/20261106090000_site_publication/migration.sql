-- Publication du site depuis l'ERP (lot E3) : historique des publications et rappels du déploiement.
-- Création de tables seulement, écrite à la main.
CREATE TABLE "SitePublication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "lock" TEXT,
    "digest" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "baseSha" TEXT,
    "commitSha" TEXT,
    "runUrl" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" DATETIME,
    "finishedAt" DATETIME,
    "liveAt" DATETIME
);
-- Une seule publication en cours : la colonne vaut 'RUNNING' pendant la publication, NULL ensuite.
CREATE UNIQUE INDEX "SitePublication_lock_key" ON "SitePublication"("lock");
CREATE INDEX "SitePublication_startedAt_idx" ON "SitePublication"("startedAt");
CREATE INDEX "SitePublication_commitSha_idx" ON "SitePublication"("commitSha");

-- Rappels signés de l'Action du site : un par livraison (anti-rejeu durable).
CREATE TABLE "SiteDeployEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deliveryId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "runUrl" TEXT,
    "publicationId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteDeployEvent_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "SitePublication" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SiteDeployEvent_deliveryId_key" ON "SiteDeployEvent"("deliveryId");
