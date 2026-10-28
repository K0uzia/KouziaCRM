-- Messagerie : expéditeurs bloqués et de confiance (accord d'Alexandre du 28/10/2026). Additive : nouvelle table seule.
-- CreateTable
CREATE TABLE "MailSenderRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "MailSenderRule_action_idx" ON "MailSenderRule"("action");

-- CreateIndex
CREATE UNIQUE INDEX "MailSenderRule_kind_value_key" ON "MailSenderRule"("kind", "value");

