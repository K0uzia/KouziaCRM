-- Données personnelles chiffrées au repos (décision d'Alexandre du 27/10/2026), additive, comme la migration
-- 20261109090000 : le code écrit la colonne chiffrée et laisse l'ancienne vide ; le worker recopie chiffré les lignes
-- existantes puis vide l'ancienne colonne après relecture. Les anciennes colonnes ne sont jamais supprimées.
-- Copie du client figée dans un document émis (e-mail, téléphone, SIRET, adresse).
ALTER TABLE "Invoice" ADD COLUMN "clientSnapshotEncrypted" TEXT;
-- Corps des e-mails de la messagerie.
ALTER TABLE "EmailMessage" ADD COLUMN "bodyTextEncrypted" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "bodyHtmlEncrypted" TEXT;
-- IBAN de la contrepartie d'une opération bancaire.
ALTER TABLE "BankTransaction" ADD COLUMN "counterpartyIbanEncrypted" TEXT;
