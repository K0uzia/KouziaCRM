import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { decrypt, derivedKey, encrypt } from "@/lib/crypto.js";

// Documents archivés chiffrés au repos (demande du 27/10/2026, « copie client des factures ») : les PDF figés (factures,
// avoirs, devis, reçus, devis signés) et leur version lisible portent les coordonnées du client.
// - Fichier PDF : en-tête « KZE1 », IV, tag, puis le PDF chiffré (AES-256-GCM, sous-clé dédiée « archives »). Lecture :
//   le PDF d'origine, dont l'empreinte SHA-256 enregistrée reste celle du PDF ; un fichier ancien en clair (« %PDF »)
//   reste lu tel quel, jusqu'à sa recopie chiffrée par le worker.
// - Version lisible (texte JSON en base) : « enc1: » puis le JSON chiffré ; le marqueur « indisponible », sans donnée
//   personnelle, reste en clair.

const MAGIC = Buffer.from("KZE1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const READABLE_PREFIX = "enc1:";

const key = () => derivedKey("archives");

export function isSealedArchive(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function sealArchive(pdf: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(pdf), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function openArchive(stored: Buffer): Buffer {
  if (!isSealedArchive(stored)) return stored;
  const iv = stored.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = stored.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(stored.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH)), decipher.final()]);
}

/** Écrit un PDF archivé, chiffré. `flag` comme fs.writeFile (« wx » : jamais d'écrasement). */
export async function writeArchiveFile(abs: string, pdf: Buffer, flag = "w"): Promise<void> {
  await fs.writeFile(abs, sealArchive(pdf), { flag });
}

/** PDF archivé, déchiffré (ou ancien fichier en clair). */
export async function readArchiveFile(abs: string): Promise<Buffer> {
  return openArchive(await fs.readFile(abs));
}

/**
 * Recopie chiffrée d'un ancien PDF en clair : fichier temporaire puis renommage (jamais de fichier à moitié écrit),
 * seulement si la relecture redonne le même PDF. Rend true si le fichier a été chiffré.
 */
export async function sealExistingArchiveFile(abs: string): Promise<boolean> {
  const stored = await fs.readFile(abs);
  if (isSealedArchive(stored)) return false;
  const sealed = sealArchive(stored);
  if (!openArchive(sealed).equals(stored)) throw new Error("relecture du PDF chiffré différente");
  const tmp = `${abs}.chiffrement`;
  await fs.writeFile(tmp, sealed);
  await fs.rename(tmp, abs);
  return true;
}

/** Version lisible à enregistrer : chiffrée si elle porte un document, marqueur d'indisponibilité tel quel. */
export function sealReadable(snapshot: string): string {
  return snapshot.startsWith('{"version":1') ? `${READABLE_PREFIX}${encrypt(snapshot)}` : snapshot;
}

/** Version lisible enregistrée, en clair (déchiffrée, ou ancienne valeur en clair). */
export function openReadable(stored: string): string {
  return stored.startsWith(READABLE_PREFIX) ? decrypt(stored.slice(READABLE_PREFIX.length)) : stored;
}

export function isSealedReadable(stored: string | null | undefined): boolean {
  return Boolean(stored?.startsWith(READABLE_PREFIX));
}
