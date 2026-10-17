-- Devis préparé hors ligne et créé avec un écart (client modifié, prix changé) : motif court « à relire »,
-- visible sur tous les appareils, effacé à la relecture ou à l'émission. Colonne nullable ajoutée seulement.
ALTER TABLE "Invoice" ADD COLUMN "offlineReviewReason" TEXT;
