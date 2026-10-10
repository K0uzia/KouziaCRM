-- Besoins notés pour un client (rendez-vous) : JSON [{ id, label, done }], ordre = ordre affiché.
ALTER TABLE "Client" ADD COLUMN "needs" TEXT NOT NULL DEFAULT '[]';
