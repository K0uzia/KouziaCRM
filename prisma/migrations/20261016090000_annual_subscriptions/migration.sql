-- Abonnement annuel : remise par défaut (mois offerts), périodicité des lignes de devis, rappel J-30 (colonnes additives).
ALTER TABLE "CompanySettings" ADD COLUMN "annualFreeMonths" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "InvoiceLine" ADD COLUMN "billingInterval" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "renewalReminderSentFor" DATETIME;
