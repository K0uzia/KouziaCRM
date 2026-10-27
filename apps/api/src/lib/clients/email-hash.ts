import { createHmac } from "node:crypto";
import { derivedKey } from "@/lib/crypto.js";

/**
 * HMAC-SHA256 de l'email normalise (lookup indexe sans decrypt). Sous-clé dédiée (HKDF, usage « email-hash ») : la clé
 * de chiffrement ne sert jamais telle quelle au hachage (décision du 27/10/2026). Les hachages calculés avec la clé
 * elle-même sont recalculés au démarrage (backfillClientEmailHashes).
 */
export function computeEmailHash(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  if (!process.env.ENCRYPTION_KEY) return null;
  return createHmac("sha256", derivedKey("email-hash")).update(normalized).digest("hex");
}
