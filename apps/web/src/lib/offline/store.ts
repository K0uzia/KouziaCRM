import { openDB, type IDBPDatabase } from "idb";

/**
 * Copie locale chiffrée (IndexedDB) : AES-GCM 256, clé WebCrypto non extractible gardée dans la base,
 * IV aléatoire de 12 octets par enregistrement, clé de l'enregistrement liée en données authentifiées
 * (une valeur déplacée sous une autre clé ne se déchiffre plus). Aucun code de déverrouillage. Effacement : seulement
 * sur demande ou selon les options de cet appareil (lib/offline/device.ts, toutes désactivées par défaut).
 */
export const OFFLINE_DB = "kouzia-hors-ligne";
/**
 * Liste fermée des magasins : check:offline vérifie qu'il n'en existe aucun autre.
 * - cle : la clé AES-GCM ; copies : lectures copiées (lot 2) ;
 * - file : créations préparées hors ligne, à envoyer (lot 3) ; relire : créations envoyées avec un écart signalé.
 */
export const OFFLINE_STORES = ["cle", "copies", "file", "relire"] as const;
export type SealedStore = "copies" | "file" | "relire";
const KEY_ID = "principale";
/** Utilisateur courant (sans aucun secret), pour ouvrir l'ERP sans réseau. */
const USER_ID = "session:utilisateur";

export type Sealed = { iv: Uint8Array; data: ArrayBuffer };
/**
 * Version du format des copies : à augmenter quand la forme d'une copie change (liste blanche, structure). Une copie
 * d'une autre version est ignorée (relue en ligne), jamais servie à un écran qui la lirait mal. Les copies écrites
 * avant ce champ sont du format 1.
 */
export const COPY_FORMAT = 1;
export type Copy<T = unknown> = { v?: number; savedAt: number; data: T };

let dbPromise: Promise<IDBPDatabase> | null = null;
let keyPromise: Promise<CryptoKey> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(OFFLINE_DB, 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore("cle");
        database.createObjectStore("copies");
      }
      if (oldVersion < 2) {
        database.createObjectStore("file");
        database.createObjectStore("relire");
      }
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

// Données authentifiées : la clé de l'enregistrement, préfixée du magasin hors « copies » (compatibilité lot 2).
const aad = (store: SealedStore, id: string) => (store === "copies" ? id : `${store}:${id}`);

async function put(id: string, value: unknown, store: SealedStore = "copies"): Promise<void> {
  const cryptoKey = await key();
  const sealed = await seal(value, cryptoKey, aad(store, id));
  await (await db()).put(store, sealed, id);
}

async function get<T>(id: string, store: SealedStore = "copies"): Promise<T | null> {
  const sealed = (await (await db()).get(store, id)) as Sealed | undefined;
  if (!sealed) return null;
  try {
    return await unseal<T>(sealed, await key(), aad(store, id));
  } catch {
    // Enregistrement illisible (clé remplacée, donnée altérée) : traité comme absent.
    return null;
  }
}

/** Enregistrement chiffré d'un magasin de la file (créations préparées, écarts à relire). */
export function putSealed(store: Exclude<SealedStore, "copies">, id: string, value: unknown): Promise<void> {
  return put(id, value, store);
}

export async function deleteSealed(store: Exclude<SealedStore, "copies">, id: string): Promise<void> {
  await (await db()).delete(store, id);
}

/** Tous les enregistrements lisibles d'un magasin ; un enregistrement illisible est ignoré. */
export async function readAllSealed<T>(store: Exclude<SealedStore, "copies">): Promise<T[]> {
  const database = await db();
  const ids = (await database.getAllKeys(store)).map(String);
  const values = await Promise.all(ids.map((id) => get<T>(id, store)));
  return values.filter((v): v is Awaited<T> => v !== null) as T[];
}

export function saveCopy(path: string, data: unknown, savedAt = Date.now()): Promise<void> {
  return put(path, { v: COPY_FORMAT, savedAt, data } satisfies Copy);
}

export async function readCopy<T>(path: string): Promise<Copy<T> | null> {
  const copy = await get<Copy<T>>(path);
  return copy && (copy.v ?? 1) === COPY_FORMAT ? copy : null;
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

/** Copies dont le chemin vérifie le prédicat, supprimées (fiche disparue du serveur et ce qui en dépend). */
export async function deleteCopiesWhere(match: (path: string) => boolean): Promise<number> {
  const database = await db();
  const ids = (await database.getAllKeys("copies")).map(String).filter((id) => id !== USER_ID && match(id));
  const tx = database.transaction("copies", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  return ids.length;
}

/** Créations préparées hors ligne pas encore envoyées (un effacement automatique ne les perd jamais). */
export async function pendingCount(): Promise<number> {
  return (await db()).count("file");
}

/**
 * Effacement de la copie de cet appareil : la clé est supprimée d'abord (tout ce qui resterait devient illisible),
 * puis les magasins sont vidés. Les créations pas encore envoyées sont perdues : l'appelant le vérifie avant.
 */
export async function wipeOfflineData(): Promise<void> {
  const database = await db();
  await database.clear("cle");
  keyPromise = null;
  const tx = database.transaction(["copies", "file", "relire"], "readwrite");
  await Promise.all([tx.objectStore("copies").clear(), tx.objectStore("file").clear(), tx.objectStore("relire").clear(), tx.done]);
}

/** Tests : copie écrite telle quelle (version de format quelconque). */
export function putCopyForTests(path: string, value: unknown): Promise<void> {
  return put(path, value);
}

/** Tests : connexion fermée, base et clé neuves au prochain accès. */
export async function resetOfflineStoreForTests(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  keyPromise = null;
  if (open) (await open.catch(() => null))?.close();
}
