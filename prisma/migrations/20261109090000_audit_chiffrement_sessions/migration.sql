-- Adresses et contenus d'e-mails chiffrés au repos, comme les autres champs *Encrypted. Le code recopie
-- chiffré puis vide les anciennes colonnes ; elles ne sont jamais supprimées.
ALTER TABLE "ClientEmailEvent" ADD COLUMN "toAddressEncrypted" TEXT;
ALTER TABLE "OnboardingInvitation" ADD COLUMN "emailEncrypted" TEXT;
ALTER TABLE "EmailOutbox" ADD COLUMN "payloadEncrypted" TEXT;
-- Session admin : dernière activité (expiration après 24 h d'inactivité, 7 jours au plus).
ALTER TABLE "Session" ADD COLUMN "lastSeenAt" DATETIME;
