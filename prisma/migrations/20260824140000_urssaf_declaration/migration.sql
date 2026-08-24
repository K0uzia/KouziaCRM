-- CreateTable
CREATE TABLE "UrssafDeclaration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "periodKey" TEXT NOT NULL,
    "periodicity" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "deadline" DATETIME NOT NULL,
    "encaisseCents" INTEGER NOT NULL,
    "amountDueCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "paidAt" DATETIME,
    "paymentRef" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "UrssafDeclaration_periodKey_key" ON "UrssafDeclaration"("periodKey");

-- CreateIndex
CREATE INDEX "UrssafDeclaration_status_idx" ON "UrssafDeclaration"("status");

-- CreateIndex
CREATE INDEX "UrssafDeclaration_deadline_idx" ON "UrssafDeclaration"("deadline");

