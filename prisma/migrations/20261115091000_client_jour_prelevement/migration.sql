-- Jour de prélèvement par défaut des abonnements du client (1 à 28) ; NULL = le 1er, comme avant. Les abonnements existants gardent le leur.
ALTER TABLE "Client" ADD COLUMN "billingDay" INTEGER;
