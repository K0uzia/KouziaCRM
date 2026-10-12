import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Jeton HMAC pour les liens de paiement / abonnement publics.
 * Format : base64url({kind,id,exp}).base64url(sig)
 * TTL long : le lien ERP est permanent ; c'est la session Checkout qui expire.
 */

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 an

export type PayTokenKind = "invoice" | "milestone" | "subscribe";

type TokenPayload = { kind: PayTokenKind; id: string; exp: number };

/** Clé propre aux jetons de paiement, dérivée de SESSION_SECRET (jamais la clé des cookies elle-même). */
function secret(): Buffer {
  const s = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!s) {
    throw new Error("SESSION_SECRET requis pour signer les jetons de paiement");
  }
  return createHmac("sha256", s).update("kouzia-pay-token-v1").digest();
}

function encodePayload(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(body: string): TokenPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (
      parsed &&
      (parsed.kind === "invoice" || parsed.kind === "milestone" || parsed.kind === "subscribe") &&
      typeof parsed.id === "string" &&
      typeof parsed.exp === "number"
    ) {
      return parsed;
    }
  } catch {
    /* invalide */
  }
  return null;
}

export function signPayToken(
  kind: PayTokenKind,
  id: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const body = encodePayload({
    kind,
    id,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPayToken(token: string): { kind: PayTokenKind; id: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const payload = decodePayload(body);
  if (!payload) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { kind: payload.kind, id: payload.id };
}
