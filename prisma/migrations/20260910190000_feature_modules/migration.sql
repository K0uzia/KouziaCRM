-- Modules ERP : banque / abonnements / Merchant API
ALTER TABLE "CompanySettings" ADD COLUMN "moduleBankEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "moduleSubscriptionsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "moduleMerchantApiEnabled" BOOLEAN NOT NULL DEFAULT false;
