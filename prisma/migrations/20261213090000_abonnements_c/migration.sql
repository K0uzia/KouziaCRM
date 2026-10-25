-- Lot C (audit des abonnements du 25/10/2026), additive.
-- Fin de la période en cours figée sur le devis de rachat (refus de la signature si elle a changé).
ALTER TABLE "Invoice" ADD COLUMN "buyoutPeriodEndsAt" DATETIME;
-- Marqueur propre à l'avis de 1re échéance (renewalReminderSentFor reste celui de la reconduction et de la fin de période).
ALTER TABLE "Subscription" ADD COLUMN "firstChargeNoticeSentFor" DATETIME;
-- Reprise : un avis de 1re échéance déjà envoyé ne repart pas.
UPDATE "Subscription" SET "firstChargeNoticeSentFor" = "renewalReminderSentFor" WHERE "renewalReminderSentFor" IS NOT NULL AND "renewalReminderSentFor" = "nextInvoiceAt";
