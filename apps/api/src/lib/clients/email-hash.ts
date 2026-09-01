import { createHmac } from "node:crypto";

/** HMAC-SHA256 de l'email normalise (lookup indexe sans decrypt). */
export function computeEmailHash(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return createHmac("sha256", Buffer.from(hex, "hex")).update(normalized).digest("hex");
}
