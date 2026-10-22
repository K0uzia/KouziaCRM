-- Demandes d'utilisation d'un logiciel (Tracebay) déposées depuis le site (validé le 22/10/2026). Table ajoutée seulement.
-- Données personnelles chiffrées (nom, e-mail, téléphone) ; recherche par emailHash ; lien vers le client converti.

-- CreateTable
CREATE TABLE "SoftwareRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "software" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "companyName" TEXT NOT NULL,
    "contactNameEncrypted" TEXT NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "phoneEncrypted" TEXT,
    "edition" TEXT NOT NULL,
    "seats" TEXT NOT NULL,
    "need" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "clientId" TEXT,
    "convertedAt" DATETIME,
    "declinedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SoftwareRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SoftwareRequest_emailHash_idx" ON "SoftwareRequest"("emailHash");
CREATE INDEX "SoftwareRequest_clientId_idx" ON "SoftwareRequest"("clientId");
CREATE INDEX "SoftwareRequest_software_status_createdAt_idx" ON "SoftwareRequest"("software", "status", "createdAt");
