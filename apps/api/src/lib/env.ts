function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Variable d'environnement requise: ${name}`);
  }
  if (v.startsWith("change-me") && process.env.NODE_ENV === "production") {
    throw new Error(`Secret trop faible en production: ${name}`);
  }
  return v;
}

export function assertSecurityEnv(): void {
  if (!process.env.SESSION_SECRET && process.env.AUTH_SECRET) {
    process.env.SESSION_SECRET = process.env.AUTH_SECRET;
  }
  requireEnv("SESSION_SECRET");
  requireEnv("ENCRYPTION_KEY");
  const key = process.env.ENCRYPTION_KEY!;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ENCRYPTION_KEY doit être 64 caractères hex (32 bytes)");
  }
}

export function getCorsOrigin(): string {
  return process.env.WEB_ORIGIN ?? process.env.AUTH_URL ?? "http://localhost:5173";
}

/** localhost et 127.0.0.1 sont équivalents en dev (navigateur vs WEB_ORIGIN). */
function withLoopbackAliases(origin: string): string[] {
  try {
    const u = new URL(origin);
    const hosts = new Set([u.hostname]);
    if (u.hostname === "localhost") hosts.add("127.0.0.1");
    if (u.hostname === "127.0.0.1") hosts.add("localhost");
    return Array.from(hosts).map((h) => {
      const copy = new URL(u.href);
      copy.hostname = h;
      return copy.origin;
    });
  } catch {
    return [origin];
  }
}

/** Origines autorisées (admin SPA + suivi public éventuel) */
export function getAllowedOrigins(): string[] {
  const primary = getCorsOrigin();
  const publicOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim();
  const set = new Set<string>();
  for (const o of withLoopbackAliases(primary)) set.add(o);
  if (publicOrigin) {
    for (const o of withLoopbackAliases(publicOrigin)) set.add(o);
  }
  return Array.from(set);
}

export function getApiPort(): number {
  return Number(process.env.API_PORT ?? 3001);
}
