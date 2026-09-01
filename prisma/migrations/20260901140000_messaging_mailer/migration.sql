-- EmailOutbox + emailHash + ClientEmailEvent links + attachments (phases 1-2)

-- CreateTable EmailOutbox
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "scheduledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "lastError" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "EmailOutbox_status_scheduledAt_idx" ON "EmailOutbox"("status", "scheduledAt");

-- Client emailHash
ALTER TABLE "Client" ADD COLUMN "emailHash" TEXT;
CREATE UNIQUE INDEX "Client_emailHash_key" ON "Client"("emailHash");

-- ClientEmailEvent links
ALTER TABLE "ClientEmailEvent" ADD COLUMN "outboxId" TEXT;
ALTER TABLE "ClientEmailEvent" ADD COLUMN "threadId" TEXT;
CREATE INDEX "ClientEmailEvent_outboxId_idx" ON "ClientEmailEvent"("outboxId");
CREATE INDEX "ClientEmailEvent_threadId_idx" ON "ClientEmailEvent"("threadId");

-- EmailThread hasAttachments
ALTER TABLE "EmailThread" ADD COLUMN "hasAttachments" BOOLEAN NOT NULL DEFAULT false;

-- EmailMessage isRead
ALTER TABLE "EmailMessage" ADD COLUMN "isRead" BOOLEAN NOT NULL DEFAULT false;

-- EmailAttachment
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EmailAttachment_messageId_idx" ON "EmailAttachment"("messageId");
