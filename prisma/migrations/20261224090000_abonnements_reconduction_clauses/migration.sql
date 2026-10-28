-- Audit abonnements du 28/10/2026 (décisions d'Alexandre). Additive : aucune colonne retirée, aucune donnée effacée.
-- 1. Clauses légales : ancien texte par défaut gardé quand l'ERP le remplace d'office (upgradeDefaultClauseTexts, au
--    démarrage : seulement une clause dont le texte est encore exactement l'ancien texte par défaut).
ALTER TABLE "LegalClause" ADD COLUMN "previousBody" TEXT;
ALTER TABLE "LegalClause" ADD COLUMN "bodyReplacedAt" DATETIME;
-- 2. Information de reconduction (L215-1) : marquée à l'envoi effectif (renewalReminderSentAt), plus à la mise en file.
ALTER TABLE "Subscription" ADD COLUMN "renewalReminderSentAt" DATETIME;
ALTER TABLE "Subscription" ADD COLUMN "renewalReminderPendingFor" DATETIME;
-- Avis déjà partis : date d'envoi réelle reprise de la file d'envoi. Avis marqués sans envoi retrouvé : date laissée
-- vide (l'avis est tenu pour fait, rien n'est inventé).
UPDATE "Subscription"
SET "renewalReminderSentAt" = (
  SELECT MAX("sentAt") FROM "EmailOutbox"
  WHERE "EmailOutbox"."documentId" = "Subscription"."id"
    AND "EmailOutbox"."reviewKind" IN ('subscription_renewal', 'subscription_term_end', 'subscription_term_end_buyout')
    AND "EmailOutbox"."status" = 'SENT'
)
WHERE "renewalReminderSentFor" IS NOT NULL;
