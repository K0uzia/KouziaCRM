-- Date immatriculation RNE et suivi déclaration de revenus
ALTER TABLE "CompanySettings" ADD COLUMN "rneRegistrationDate" DATETIME;
ALTER TABLE "CompanySettings" ADD COLUMN "lastIncomeTaxDeclaredYear" INTEGER;
