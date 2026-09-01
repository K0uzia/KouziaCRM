import { randomBytes } from "node:crypto";

export function generateMessageId(outboxId: string, domain = "kouzia.local"): string {
  return `<${outboxId}@${domain}>`;
}

export function buildReferences(inReplyTo?: string | null, existing?: string | null): string | undefined {
  const parts: string[] = [];
  if (existing?.trim()) {
    parts.push(...existing.split(/\s+/).filter(Boolean));
  }
  if (inReplyTo?.trim() && !parts.includes(inReplyTo.trim())) {
    parts.push(inReplyTo.trim());
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Formate l'expediteur avec nom affiche optionnel. */
export function formatFrom(from: string, fromName?: string | null): string {
  if (!fromName?.trim()) return from;
  if (from.includes("<") && from.includes(">")) return from;
  const emailMatch = from.match(/<([^>]+)>/);
  const email = emailMatch?.[1] ?? from.trim();
  return `${fromName.trim()} <${email}>`;
}

export function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}

export function extractDisplayName(from: string): string | null {
  const trimmed = from.trim();
  const match = trimmed.match(/^(?:"?([^"<]+)"?\s*)<\s*[^>]+>\s*$/);
  const name = match?.[1]?.trim();
  return name || null;
}
