-- CreateTable
CREATE TABLE "ClientRenewal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT,
    "renewsAt" DATETIME NOT NULL,
    "interval" TEXT NOT NULL DEFAULT 'YEAR',
    "notifyClient" BOOLEAN NOT NULL DEFAULT false,
    "noticeSentFor" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientRenewal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClientRenewal_clientId_idx" ON "ClientRenewal"("clientId");

-- CreateIndex
CREATE INDEX "ClientRenewal_renewsAt_idx" ON "ClientRenewal"("renewsAt");

