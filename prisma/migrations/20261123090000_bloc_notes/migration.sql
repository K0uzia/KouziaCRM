-- Bloc-notes unique par client, chiffré au repos. Colonnes ajoutées seulement : Client.notes et ClientNote restent
-- en place (lecture seule) ; la reprise de leur contenu dans le bloc-notes est une étape à part (kouziactl reprise),
-- lancée par la mise à jour après sa sauvegarde.
ALTER TABLE "Client" ADD COLUMN "notepadEncrypted" TEXT;
ALTER TABLE "Client" ADD COLUMN "notepadVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "notepadUpdatedAt" DATETIME;
ALTER TABLE "Client" ADD COLUMN "notepadConflictAt" DATETIME;
