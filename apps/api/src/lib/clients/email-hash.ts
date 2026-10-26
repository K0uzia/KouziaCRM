import { createHmac } from "node:crypto";
import { encryptionKey } from "@/lib/crypto.js";

/** HMAC-SHA256 de l'email normalise (lookup indexe sans decrypt). */
export function computeEmailHash(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  // Hachage historique avec la clé elle-même : le changer obligerait à recalculer tous les emailHash en base.
  if (!process.env.ENCRYPTION_KEY) return null;
  return createHmac("sha256", encryptionKey()).update(normalized).digest("hex");
}
