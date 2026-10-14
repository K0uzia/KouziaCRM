-- Espace Site (lot E1) : contenu de kouzia.com géré dans l'ERP, jeton GitHub chiffré. Additif : 3 colonnes
-- facultatives dans CompanySettings et 6 tables nouvelles, sans toucher aux données existantes.

-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN "githubTokenEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "githubTokenExpiresAt" DATETIME;
ALTER TABLE "CompanySettings" ADD COLUMN "githubTokenHint" TEXT;

-- CreateTable
CREATE TABLE "SiteProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "role" TEXT,
    "techJson" TEXT,
    "url" TEXT NOT NULL,
    "linkLabel" TEXT NOT NULL,
    "imagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SiteReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "author" TEXT NOT NULL,
    "reviewedOn" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rating" INTEGER,
    "googleUrl" TEXT,
    "consentAt" DATETIME,
    "consentChannel" TEXT,
    "consentProofEncrypted" TEXT,
    "withdrawalRequestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SiteReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoPath" TEXT,
    "url" TEXT,
    "productSlug" TEXT,
    "testimonialText" TEXT,
    "testimonialAuthor" TEXT,
    "testimonialRole" TEXT,
    "authorizationAt" DATETIME,
    "authorizationChannel" TEXT,
    "authorizationScope" TEXT,
    "contactEncrypted" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SiteFaq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "page" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SiteText" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SiteMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sha12" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width2x" INTEGER,
    "height2x" INTEGER,
    "bytes2x" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteProject_slug_key" ON "SiteProject"("slug");

-- CreateIndex
CREATE INDEX "SiteProject_status_position_idx" ON "SiteProject"("status", "position");

-- CreateIndex
CREATE INDEX "SiteReview_status_position_idx" ON "SiteReview"("status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SiteReference_slug_key" ON "SiteReference"("slug");

-- CreateIndex
CREATE INDEX "SiteReference_status_position_idx" ON "SiteReference"("status", "position");

-- CreateIndex
CREATE INDEX "SiteFaq_page_status_position_idx" ON "SiteFaq"("page", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SiteMedia_sha12_key" ON "SiteMedia"("sha12");

