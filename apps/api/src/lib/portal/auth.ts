import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Client } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { getCookieSecure } from "@/lib/env.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

/**
 * Espace client : connexion par code à 6 chiffres envoyé par e-mail, puis appareil
 * reconnu 15 jours. Le même mécanisme de code confirme chaque signature de devis.
 */

export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes envoyés au plus par client, par usage et par heure (anti-harcèlement). */
export const CODE_MAX_PER_HOUR = 5;
export const SESSION_TTL_MS = 15 * 86_400_000;

export const PORTAL_COOKIE = "kz_portal";
export const DEVICE_COOKIE = "kz_device";
/** 13 mois au plus : durée maximale recommandée par la CNIL pour un cookie. */
const DEVICE_TTL_MS = 390 * 86_400_000;
/** Traces de connexion (IP, navigateur) gardées 1 an après la fin de la session. */
export const SESSION_LOG_RETENTION_MS = 365 * 86_400_000;
/** Les cookies ne servent qu'aux routes publiques du portail. */
const COOKIE_PATH = "/api/public";

export type CodePurpose = "LOGIN" | "SIGN";
export type CodeCheck = "ok" | "invalid" | "locked";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function hashCode(code: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET manquant");
  return createHmac("sha256", secret).update(code).digest("hex");
}

/** j***@exemple.fr : montre à quelle adresse le code est parti sans la dévoiler. */
export function maskEmail(email: string): string {
  const [local, domain] = email.trim().split("@");
  if (!local || !domain) return "***";
  return `${local.charAt(0)}***@${domain}`;
}

export async function findClientByEmail(email: string): Promise<Client | null> {
  const emailHash = computeEmailHash(email);
  if (!emailHash) return null;
  return prisma.client.findUnique({ where: { emailHash } });
}

/**
 * Crée un code et invalide les précédents du même usage. Renvoie null si la limite
 * horaire est atteinte : l'appelant répond comme si le code était parti.
 */
export async function issuePortalCode(
  clientId: string,
  purpose: CodePurpose,
  quoteId: string | null = null,
): Promise<string | null> {
  const recent = await prisma.portalCode.count({
    where: { clientId, purpose, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
  });
  if (recent >= CODE_MAX_PER_HOUR) return null;

  const now = new Date();
  await prisma.portalCode.updateMany({
    where: { clientId, purpose, quoteId, usedAt: null, expiresAt: { gt: now } },
    data: { expiresAt: now },
  });
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.portalCode.create({
    data: {
      clientId,
      purpose,
      quoteId,
      codeHash: hashCode(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    },
  });
  return code;
}

/** Vérifie le dernier code valide ; chaque échec compte, le code est détruit au 5e. */
export async function checkPortalCode(
  clientId: string,
  purpose: CodePurpose,
  code: string,
  quoteId: string | null = null,
): Promise<CodeCheck> {
  const row = await prisma.portalCode.findFirst({
    where: { clientId, purpose, quoteId, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return "invalid";
  if (row.attempts >= CODE_MAX_ATTEMPTS) return "locked";

  const expected = Buffer.from(row.codeHash, "hex");
  const given = Buffer.from(hashCode(code.replace(/\s/g, "")), "hex");
  if (!timingSafeEqual(expected, given)) {
    const attempts = row.attempts + 1;
    await prisma.portalCode.update({ where: { id: row.id }, data: { attempts } });
    return attempts >= CODE_MAX_ATTEMPTS ? "locked" : "invalid";
  }
  await prisma.portalCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return "ok";
}

/**
 * Ouvre une session sur cet appareil. `newDevice` : le client s'était déjà connecté,
 * mais jamais depuis cet appareil (déclenche l'e-mail d'alerte).
 */
export async function openPortalSession(opts: {
  clientId: string;
  deviceId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<{ token: string; expiresAt: Date; newDevice: boolean }> {
  const deviceHash = sha256(opts.deviceId);
  const [known, previous] = await Promise.all([
    prisma.portalSession.count({ where: { clientId: opts.clientId, deviceHash } }),
    prisma.portalSession.count({ where: { clientId: opts.clientId } }),
  ]);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.portalSession.create({
    data: {
      clientId: opts.clientId,
      tokenHash: sha256(token),
      deviceHash,
      ipAddress: opts.ipAddress?.slice(0, 64) ?? null,
      userAgent: opts.userAgent?.slice(0, 512) ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt, newDevice: previous > 0 && known === 0 };
}

/** Client de la session portail de la requête, ou null (absente, expirée, révoquée). */
export async function resolvePortalClient(request: FastifyRequest): Promise<Client | null> {
  return (await resolvePortalSession(request))?.client ?? null;
}

/** Session du portail et son client (l'identifiant de session sert de preuve, ex. accord d'un témoignage). */
export async function resolvePortalSession(request: FastifyRequest): Promise<{ client: Client; sessionId: string } | null> {
  const token = request.cookies[PORTAL_COOKIE];
  if (!token) return null;
  const session = await prisma.portalSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { client: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  await prisma.portalSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return { client: session.client, sessionId: session.id };
}

export async function closePortalSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies[PORTAL_COOKIE];
  if (!token) return;
  await prisma.portalSession.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Déconnecte tous les appareils d'un client (admin : appareil perdu, doute). */
export async function revokeAllPortalSessions(clientId: string): Promise<number> {
  const res = await prisma.portalSession.updateMany({
    where: { clientId, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/**
 * Purge (worker, toutes les heures) : codes expirés depuis plus d'un jour, sessions
 * terminées depuis plus d'un an. Les preuves de signature ne sont pas concernées.
 */
export async function purgePortalData(now = new Date()): Promise<{ codes: number; sessions: number }> {
  const [codes, sessions] = await Promise.all([
    prisma.portalCode.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
    }),
    prisma.portalSession.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - SESSION_LOG_RETENTION_MS) } },
    }),
  ]);
  return { codes: codes.count, sessions: sessions.count };
}

/** Identifiant d'appareil existant, ou nouveau (posé avec la session). */
export function deviceIdOf(request: FastifyRequest): string {
  const existing = request.cookies[DEVICE_COOKIE];
  return existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing)
    ? existing
    : randomBytes(24).toString("base64url");
}

// SameSite=Lax : kouzia.com et api.kouzia.com sont le même site, le cookie suit les appels fetch.
const cookieBase = () => ({
  path: COOKIE_PATH,
  httpOnly: true,
  sameSite: "lax" as const,
  secure: getCookieSecure(),
});

export function setPortalCookies(
  reply: FastifyReply,
  session: { token: string; expiresAt: Date },
  deviceId: string,
): void {
  reply.setCookie(PORTAL_COOKIE, session.token, { ...cookieBase(), expires: session.expiresAt });
  reply.setCookie(DEVICE_COOKIE, deviceId, {
    ...cookieBase(),
    expires: new Date(Date.now() + DEVICE_TTL_MS),
  });
}

export function clearPortalCookie(reply: FastifyReply): void {
  reply.clearCookie(PORTAL_COOKIE, cookieBase());
}

/** « Chrome sous Windows » : assez pour qu'un client reconnaisse (ou non) son appareil. */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "un navigateur";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone ou iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "un système inconnu";
  return `${browser} sous ${os}`;
}
