-- Retraits de l'entrepreneur saisis à la main, déduits du salaire disponible (additif).
CREATE TABLE "OwnerWithdrawal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amountCents" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "note" TEXT,
    "createdByEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OwnerWithdrawal_date_idx" ON "OwnerWithdrawal"("date");
