-- Contacts multiples par client (particulier compris). Table ajoutée seulement : Client.email, phone, firstName et
-- lastName restent la référence (espace client, /suivi, API publique) ; le contact principal est tenu synchronisé.
-- Un seul principal par client, garanti par l'API. La reprise (un contact principal par client qui a un nom, un
-- e-mail ou un téléphone) est une étape à part : kouziactl reprise, lancée par la mise à jour après sa sauvegarde.
-- CreateTable
CREATE TABLE "ClientContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" TEXT,
    "emailEncrypted" TEXT,
    "emailHash" TEXT,
    "phoneEncrypted" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClientContact_clientId_position_idx" ON "ClientContact"("clientId", "position");

-- CreateIndex
CREATE INDEX "ClientContact_emailHash_idx" ON "ClientContact"("emailHash");

