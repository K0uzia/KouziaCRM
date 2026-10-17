-- Drapeaux (lu, étoile) modifiés dans l'ERP et pas encore écrits sur le serveur IMAP.
-- La synchro les pousse vers la boîte au lieu de les écraser. Colonne ajoutée seulement ; aucune donnée modifiée.
ALTER TABLE "EmailMessage" ADD COLUMN "flagsPending" BOOLEAN NOT NULL DEFAULT false;
