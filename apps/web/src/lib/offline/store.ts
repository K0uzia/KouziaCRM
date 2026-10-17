import { openDB, type IDBPDatabase } from "idb";

/**
 * Copie locale chiffrée (IndexedDB) : AES-GCM 256, clé WebCrypto non extractible gardée dans la base,
 * IV aléatoire de 12 octets par enregistrement, clé de l'enregistrement liée en données authentifiées
 * (une valeur déplacée sous une autre clé ne se déchiffre plus). Aucun code de déverrouillage, aucun
 * effacement automatique (réglage par appareil au lot 4).
 */
export const OFFLINE_DB = "kouzia-hors-ligne";
/** Liste fermée des magasins : check:offline vérifie qu'il n'en existe aucun autre. */
export const OFFLINE_STORES = ["cle", "copies"] as const;
const KEY_ID = "principale";
/** Utilisateur courant (sans aucun secret), pour ouvrir l'ERP sans réseau. */
const USER_ID = "session:utilisateur";

export type Sealed = { iv: Uint8Array; data: ArrayBuffer };
export type Copy<T = unknown> = { savedAt: number; data: T };

let dbPromise: Promise<IDBPDatabase> | null = null;
let keyPromise: Promise<CryptoKey> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(OFFLINE_DB, 1, {
    upgrade(database) {
      database.createObjectStore("cle");
      database.createObjectStore("copies");
    },
    // Autre onglet en mise à niveau ou base supprimée : connexion rendue, rouverte au prochain accès.
    blocking(_current, _next, event) {
      (event.target as IDBDatabase).close();
      dbPromise = null;
    },
  });
  return dbPromise;
}

async function loadKey(): Promise<CryptoKey> {
  const database = await db();
  const existing = (await database.get("cle", KEY_ID)) as CryptoKey | undefined;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  try {
    await database.add("cle", key, KEY_ID);
    return key;
  } catch {
    // Autre onglet plus rapide : sa clé fait foi.
    return (await database.get("cle", KEY_ID)) as CryptoKey;
  }
}

function key(): Promise<CryptoKey> {
  keyPromise ??= loadKey().catch((error: unknown) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}

const encoder = new TextEncoder();

export async function seal(value: unknown, cryptoKey: CryptoKey, id: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(id) },
    cryptoKey,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv, data };
}

export async function unseal<T>(sealed: Sealed, cryptoKey: CryptoKey, id: string): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv as Uint8Array<ArrayBuffer>, additionalData: encoder.encode(id) },
    cryptoKey,
    sealed.data,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

async function put(id: string, value: unknown): Promise<void> {
  const cryptoKey = await key();
  const sealed = await seal(value, cryptoKey, id);
  await (await db()).put("copies", sealed, id);
}

async function get<T>(id: string): Promise<T | null> {
  const sealed = (await (await db()).get("copies", id)) as Sealed | undefined;
  if (!sealed) return null;
  try {
    return await unseal<T>(sealed, await key(), id);
  } catch {
    // Enregistrement illisible (clé remplacée, donnée altérée) : traité comme absent.
    return null;
  }
}

export function saveCopy(path: string, data: unknown, savedAt = Date.now()): Promise<void> {
  return put(path, { savedAt, data } satisfies Copy);
}

export function readCopy<T>(path: string): Promise<Copy<T> | null> {
  return get<Copy<T>>(path);
}

export type OfflineUser = { id: string; email: string; name: string | null };

export function saveUser(user: OfflineUser): Promise<void> {
  return put(USER_ID, { id: user.id, email: user.email, name: user.name } satisfies OfflineUser);
}

export function readUser(): Promise<OfflineUser | null> {
  return get<OfflineUser>(USER_ID);
}

/** Déconnexion ou session refusée par le serveur : l'ERP ne s'ouvre plus sans réseau (la copie reste). */
export async function forgetUser(): Promise<void> {
  await (await db()).delete("copies", USER_ID);
}

/** Tests : connexion fermée, base et clé neuves au prochain accès. */
export async function resetOfflineStoreForTests(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  keyPromise = null;
  if (open) (await open.catch(() => null))?.close();
}
