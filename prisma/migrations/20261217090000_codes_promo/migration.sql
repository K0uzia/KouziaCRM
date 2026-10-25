-- Lot R3 (26/10/2026), additive : codes promo saisis par l'admin sur un devis récurrent ; usages calculés, jamais stockés.
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "months" INTEGER,
    "validFrom" DATETIME,
    "validUntil" DATETIME,
    "maxUses" INTEGER,
    "serviceIds" TEXT,
    "conditionText" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- Lien du devis au code : SQLite n'ajoute pas de clé étrangère par ALTER TABLE ADD COLUMN avec contrainte nommée ;
-- la colonne porte la référence (ON DELETE RESTRICT), comme les autres liens ajoutés après coup.
ALTER TABLE "Invoice" ADD COLUMN "promoCodeId" TEXT REFERENCES "PromoCode" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Invoice_promoCodeId_idx" ON "Invoice"("promoCodeId");
