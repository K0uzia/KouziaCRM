import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { webAdminOrigin } from "@/lib/google-calendar/config.js";

// Paramètre `state` OAuth signé : sans lui, n'importe qui pouvait appeler le callback avec le code
// de son propre compte Google et relier l'agenda de l'ERP à ce compte.

const STATE_TTL_MS = 10 * 60_000;

function secret(): Buffer {
  const s = process.env.SESSION_SECRET?.trim();
  if (!s) throw new Error("SESSION_SECRET requis");
  return Buffer.from(`google-oauth-state:${s}`, "utf8");
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

/** Origines d'où l'admin peut lancer la connexion Google : LAN, Internet (erp.), Tailscale. */
export function adminOrigins(): string[] {
  return [process.env.WEB_ORIGIN, process.env.ADMIN_PUBLIC_ORIGIN, process.env.TAILSCALE_ORIGIN]
    .map(normalizeOrigin)
    .filter((o): o is string => o !== null);
}

/** Origine de retour demandée si elle est dans la liste blanche, sinon l'admin LAN. */
export function resolveReturnOrigin(requested: string | undefined): string {
  const wanted = normalizeOrigin(requested);
  return wanted && adminOrigins().includes(wanted) ? wanted : webAdminOrigin();
}

export function createOAuthState(returnOrigin: string, nowMs = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ o: returnOrigin, n: randomBytes(12).toString("base64url"), e: nowMs + STATE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Origine de retour si le state est authentique, non expiré et toujours dans la liste blanche. */
export function verifyOAuthState(state: string | undefined, nowMs = Date.now()): string | null {
  const [payload, sig] = (state ?? "").split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { o?: string; e?: number };
    if (typeof data.e !== "number" || data.e < nowMs) return null;
    const origin = normalizeOrigin(data.o);
    return origin && adminOrigins().includes(origin) ? origin : null;
  } catch {
    return null;
  }
}
