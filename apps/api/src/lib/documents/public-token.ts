import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  return process.env.SESSION_SECRET || process.env.AUTH_SECRET || "dev-secret";
}

/** Token HMAC pour PDF public : base64url(id).base64url(sig) */
export function signDocumentToken(invoiceId: string): string {
  const payload = Buffer.from(invoiceId, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret()).update(invoiceId).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyDocumentToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  let invoiceId: string;
  try {
    invoiceId = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret()).update(invoiceId).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return invoiceId;
}
