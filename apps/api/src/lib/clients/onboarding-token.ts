import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type OnboardingTokenPayload = {
  jti: string;
  email: string;
  existingClientId: string | null;
  exp: number;
};

function hmacSecret(): string {
  const s =
    process.env.ONBOARDING_HMAC_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    "";
  if (!s) throw new Error("ONBOARDING_HMAC_SECRET ou SESSION_SECRET requis");
  return s;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", hmacSecret()).update(payloadB64).digest("base64url");
}

export function getOnboardingTtlDays(): number {
  const n = Number(process.env.ONBOARDING_TOKEN_TTL_DAYS ?? 7);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** Crée un token HMAC signé + jti pour l'invitation. */
export function createOnboardingToken(opts: {
  email: string;
  existingClientId?: string | null;
  ttlDays?: number;
}): { token: string; jti: string; expiresAt: Date; payload: OnboardingTokenPayload } {
  const jti = randomUUID();
  const ttlDays = opts.ttlDays ?? getOnboardingTtlDays();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const payload: OnboardingTokenPayload = {
    jti,
    email: opts.email.trim().toLowerCase(),
    existingClientId: opts.existingClientId ?? null,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return { token: `${payloadB64}.${sig}`, jti, expiresAt, payload };
}

/**
 * Vérifie signature HMAC + expiration.
 * Retourne null si invalide / expiré / mal formé.
 */
export function verifyOnboardingToken(token: string): OnboardingTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  if (!payloadB64 || !sig) return null;

  let expected: string;
  try {
    expected = sign(payloadB64);
  } catch {
    return null;
  }

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(json) as OnboardingTokenPayload;
    if (!payload.jti || !payload.email || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Détecte un token legacy (32 hex) vs HMAC. */
export function isLegacyOnboardingToken(token: string): boolean {
  return /^[a-f0-9]{32}$/i.test(token);
}
