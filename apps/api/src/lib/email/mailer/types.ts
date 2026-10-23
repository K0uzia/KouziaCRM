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
  /**
   * E-mail automatique destiné à un client (famille, origine) : il attend la validation de l'admin (« E-mails à
   * valider »), sauf si sa famille est validée d'office. Absent : envoi direct (clic de l'admin, alerte à l'admin,
   * code de connexion).
   */
  review?: import("@/lib/email/review.js").ReviewOptions;
};

export type EnqueueResult = {
  outboxId: string;
  messageId: string;
  /** true : en attente de validation (statut REVIEW), rien n'est envoyé tant qu'il n'est pas validé. */
  awaitingReview: boolean;
};
