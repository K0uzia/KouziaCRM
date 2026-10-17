-- Packs (approuvé par Alexandre) : une prestation « pack » regroupe des prestations du catalogue avec leur quantité.
-- Sur un devis, le pack se déplie en lignes détaillées groupées sous son titre, plus une ligne « Remise pack ».
-- Colonnes et table ajoutées seulement ; aucune donnée modifiée.
ALTER TABLE "Service" ADD COLUMN "isPack" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceLine" ADD COLUMN "groupTitle" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "isPackDiscount" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ServicePackItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ServicePackItem_packId_fkey" FOREIGN KEY ("packId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServicePackItem_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ServicePackItem_packId_idx" ON "ServicePackItem"("packId");
CREATE INDEX "ServicePackItem_serviceId_idx" ON "ServicePackItem"("serviceId");
CREATE UNIQUE INDEX "ServicePackItem_packId_serviceId_key" ON "ServicePackItem"("packId", "serviceId");
