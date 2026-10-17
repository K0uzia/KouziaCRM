-- Hors ligne, lot 3 : créations préparées hors ligne et journal des notes de rendez-vous.
-- Additif seulement : deux colonnes nullables (UUID de l'appareil, unique) et une table nouvelle ; aucune donnée modifiée.
ALTER TABLE "Client" ADD COLUMN "clientRequestId" TEXT;

ALTER TABLE "Invoice" ADD COLUMN "clientRequestId" TEXT;

-- Texte chiffré au repos (bodyEncrypted), comme les autres données personnelles ; supprimé avec la fiche client.
CREATE TABLE "ClientNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "bodyEncrypted" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "preparedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientNote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClientNote_clientRequestId_key" ON "ClientNote"("clientRequestId");

CREATE INDEX "ClientNote_clientId_preparedAt_idx" ON "ClientNote"("clientId", "preparedAt");

CREATE UNIQUE INDEX "Client_clientRequestId_key" ON "Client"("clientRequestId");

CREATE UNIQUE INDEX "Invoice_clientRequestId_key" ON "Invoice"("clientRequestId");
