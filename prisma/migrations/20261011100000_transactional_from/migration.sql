-- Expéditeur des e-mails automatiques (codes, invitation, accès, alertes), ex. noreply@kouzia.com.
ALTER TABLE "CompanySettings" ADD COLUMN "transactionalFrom" TEXT;
