-- Stripe : encaissement, catalogue, abonnements (colonnes additives, sans reconstruction).

-- CompanySettings
ALTER TABLE "CompanySettings" ADD COLUMN "moduleStripeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "stripeSecretKeyEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "stripeSecretKeyHint" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "stripeWebhookSecretEncrypted" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "stripeWebhookSecretHint" TEXT;

-- Client
ALTER TABLE "Client" ADD COLUMN "stripeCustomerId" TEXT;
CREATE UNIQUE INDEX "Client_stripeCustomerId_key" ON "Client"("stripeCustomerId");

-- Service
ALTER TABLE "Service" ADD COLUMN "stripeProductId" TEXT;
ALTER TABLE "Service" ADD COLUMN "stripePriceId" TEXT;
ALTER TABLE "Service" ADD COLUMN "billingInterval" TEXT;
CREATE UNIQUE INDEX "Service_stripePriceId_key" ON "Service"("stripePriceId");
CREATE INDEX "Service_stripeProductId_idx" ON "Service"("stripeProductId");

-- Subscription
ALTER TABLE "Subscription" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "billingInterval" TEXT;
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- Invoice
ALTER TABLE "Invoice" ADD COLUMN "stripeInvoiceId" TEXT;
CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");

-- StripePayout (avant Payment.stripePayoutId pour la FK)
CREATE TABLE "StripePayout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stripePayoutId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "arrivalDate" DATETIME,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "StripePayout_stripePayoutId_key" ON "StripePayout"("stripePayoutId");
CREATE INDEX "StripePayout_arrivalDate_idx" ON "StripePayout"("arrivalDate");
CREATE INDEX "StripePayout_status_idx" ON "StripePayout"("status");

-- Payment
ALTER TABLE "Payment" ADD COLUMN "stripePaymentIntentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "feeCents" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "stripePayoutId" TEXT;
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");
CREATE INDEX "Payment_stripePayoutId_idx" ON "Payment"("stripePayoutId");

-- StripeWebhookEvent
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "StripeWebhookEvent_eventId_key" ON "StripeWebhookEvent"("eventId");
CREATE INDEX "StripeWebhookEvent_eventType_idx" ON "StripeWebhookEvent"("eventType");
CREATE INDEX "StripeWebhookEvent_processedAt_idx" ON "StripeWebhookEvent"("processedAt");
