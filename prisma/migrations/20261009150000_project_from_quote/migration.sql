-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClientProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "steps" TEXT NOT NULL DEFAULT '[]',
    "links" TEXT NOT NULL DEFAULT '[]',
    "checklist" TEXT NOT NULL DEFAULT '[]',
    "visibleOnPortal" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "quoteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientProject_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientProject_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ClientProject" ("checklist", "clientId", "createdAt", "id", "links", "name", "position", "progress", "steps", "updatedAt", "visibleOnPortal") SELECT "checklist", "clientId", "createdAt", "id", "links", "name", "position", "progress", "steps", "updatedAt", "visibleOnPortal" FROM "ClientProject";
DROP TABLE "ClientProject";
ALTER TABLE "new_ClientProject" RENAME TO "ClientProject";
CREATE UNIQUE INDEX "ClientProject_quoteId_key" ON "ClientProject"("quoteId");
CREATE INDEX "ClientProject_clientId_position_idx" ON "ClientProject"("clientId", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

