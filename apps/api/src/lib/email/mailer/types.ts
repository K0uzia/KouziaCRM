export type OutboxAttachment = {
  filename: string;
  contentBase64: string;
  contentType?: string;
};

export type OutboxPayload = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: OutboxAttachment[];
  clientId?: string;
  documentId?: string;
  documentNumber?: string;
  threadId?: string;
  kind?: string;
  inReplyTo?: string;
  references?: string;
  bodyTextForMessage?: string;
  reminderInvoiceId?: string;
  markAccessEmailSent?: boolean;
};

export type EnqueueOptions = {
  scheduledAt?: Date;
  maxAttempts?: number;
};

export type EnqueueResult = {
  outboxId: string;
  messageId: string;
};
