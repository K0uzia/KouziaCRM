import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 jours

function secret(): string {
  const s = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!s) {
    throw new Error("SESSION_SECRET requis pour signer les tokens PDF publics");
  }
  return s;
}

type TokenPayload = { id: string; exp: number };

function encodePayload(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(body: string): TokenPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (parsed && typeof parsed.id === "string" && typeof parsed.exp === "number") {
      return parsed;
    }
  } catch {
    /* legacy ou invalide */
  }
  return null;
}

/** Token HMAC pour PDF public : base64url({id,exp}).base64url(sig). TTL 30j. */
export function signDocumentToken(
  invoiceId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const body = encodePayload({
    id: invoiceId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyDocumentToken(token: string): string | null {
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
  if (payload) {
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.id;
  }

  // Compat tokens legacy: base64url(id).sig sans exp
  try {
    const legacyId = Buffer.from(body, "base64url").toString("utf8");
    if (legacyId && !legacyId.startsWith("{")) return legacyId;
  } catch {
    /* ignore */
  }
  return null;
}
