-- Type facultatif d'un projet client (SITE, LOGICIEL, MAINTENANCE, AUTRE), exposé à l'espace client.
ALTER TABLE "ClientProject" ADD COLUMN "kind" TEXT;
