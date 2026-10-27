import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Seule lecture de ENCRYPTION_KEY (défaut du 27/10/2026) : 64 caractères hexadécimaux exactement. Buffer.from(…, "hex")
 * s'arrête au premier caractère invalide sans erreur : une clé mal copiée serait devenue plus faible en silence.
 */
export function encryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("ENCRYPTION_KEY invalide : 64 caractères hexadécimaux attendus (openssl rand -hex 32)");
  }
  return Buffer.from(hex, "hex");
}

/** Sous-clé dédiée à un usage (HKDF-SHA256) : la clé de chiffrement ne sert jamais telle quelle à un autre usage. */
export function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey(), Buffer.alloc(0), `kouzia-erp/${purpose}`, 32));
}

const getKey = encryptionKey;

/** Encrypt plaintext → base64(iv + tag + ciphertext) */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const data = buf.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return encrypt(value.trim());
}

export function decryptOptional(value: string | null | undefined): string | null {
  if (!value) return null;
  return decrypt(value);
}
