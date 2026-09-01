export { enqueueEmail, parsePayload } from "./outbox.js";
export { processEmailOutbox, sendOutboxNow } from "./processor.js";
export type { EnqueueOptions, EnqueueResult, OutboxPayload, OutboxAttachment } from "./types.js";
export { generateMessageId, formatFrom, extractEmailAddress } from "./headers.js";

import { enqueueEmail } from "./outbox.js";
import type { EnqueueOptions, EnqueueResult, OutboxPayload } from "./types.js";

/** Enfile un email pour envoi asynchrone via le worker. */
export async function mailEnqueue(
  payload: OutboxPayload,
  opts?: EnqueueOptions,
): Promise<EnqueueResult> {
  return enqueueEmail(payload, opts);
}
