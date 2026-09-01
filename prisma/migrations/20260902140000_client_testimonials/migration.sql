-- CreateTable
CREATE TABLE "ClientTestimonial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClientTestimonial_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ClientTestimonial_clientId_idx" ON "ClientTestimonial"("clientId");
CREATE INDEX "ClientTestimonial_status_publishedAt_idx" ON "ClientTestimonial"("status", "publishedAt");
