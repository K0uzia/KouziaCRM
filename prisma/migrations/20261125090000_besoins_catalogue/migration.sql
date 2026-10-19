-- Besoins rattachés au catalogue : une ligne par prestation, case « traité » datée ; « Précisions » en texte libre.
-- Client.needs (ancien JSON) reste en lecture seule : la reprise le recopie dans needsDetails.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "needsDetails" TEXT;

-- CreateTable
CREATE TABLE "ClientServiceNeed" (
    "clientId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "doneAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("clientId", "serviceId"),
    CONSTRAINT "ClientServiceNeed_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientServiceNeed_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClientServiceNeed_serviceId_idx" ON "ClientServiceNeed"("serviceId");
