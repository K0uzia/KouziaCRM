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

/** Jeton du reçu d'un règlement (préfixe « receipt: » : inutilisable sur /api/public/documents). */
export function signReceiptToken(paymentId: string): string {
  return signDocumentToken(`receipt:${paymentId}`);
}

/** Identifiant du règlement d'un jeton de reçu ; null si invalide, expiré ou jeton de document. */
export function verifyReceiptToken(token: string): string | null {
  const id = verifyDocumentToken(token);
  return id?.startsWith("receipt:") ? id.slice("receipt:".length) : null;
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

  // Jeton sans date d'expiration (format du 25 au 27/08/2026) : refusé. Les jetons sont produits à la demande (/suivi,
  // fiche facture) et jamais stockés ; tous ceux de l'ancien format auraient expiré depuis le 26/09/2026.
  const payload = decodePayload(body);
  if (!payload || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.id;
}
