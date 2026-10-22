-- Pastilles « non vu » de /suivi (validé le 19/10/2026) : dernière ouverture de chaque rubrique par le client.
-- Table ajoutée seulement, une ligne par client et par rubrique (projects, documents, payments).

-- CreateTable
CREATE TABLE "ClientPortalSeen" (
    "clientId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "seenAt" DATETIME NOT NULL,

    PRIMARY KEY ("clientId", "section"),
    CONSTRAINT "ClientPortalSeen_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
