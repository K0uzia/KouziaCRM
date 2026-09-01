type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/** Cache mémoire TTL court pour limiter les appels aux APIs gouvernementales. */
export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const TTL = {
  /** Code postal → communes : 24 h */
  COMMUNES: 24 * 60 * 60 * 1000,
  /** Suggestions d'adresse : 5 min */
  ADRESSE: 5 * 60 * 1000,
  /** Lookup entreprise : 1 h */
  ENTREPRISE: 60 * 60 * 1000,
} as const;

/** Instance partagée (navigateur ou processus Node). */
export const sharedCache = new MemoryCache();
