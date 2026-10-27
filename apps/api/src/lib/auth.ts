import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getCookieSecure } from "@/lib/env.js";
import { prisma } from "@/lib/prisma.js";

export const SESSION_COOKIE = "kouzia_session";
/** Session admin : 7 jours au plus depuis la connexion, close après 24 h sans requête. */
export const SESSION_TTL_MS = 7 * 86_400_000;
export const SESSION_IDLE_MS = 86_400_000;
/** lastSeenAt réécrit au plus toutes les 5 minutes (pas une écriture par requête). */
const SESSION_TOUCH_MS = 5 * 60_000;

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    sessionId?: string;
  }
}

function isBcryptHash(hash: string): boolean {
  return hash.startsWith("$2a$") || hash.startsWith("$2b$") || hash.startsWith("$2y$");
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (isBcryptHash(passwordHash)) {
    return bcrypt.compare(password, passwordHash);
  }
  return argon2.verify(passwordHash, password);
}

/** Après login réussi : migre bcrypt → argon2id si besoin. */
export async function upgradePasswordHashIfNeeded(
  userId: string,
  password: string,
  currentHash: string,
): Promise<void> {
  if (!isBcryptHash(currentHash)) return;
  const next = await hashPassword(password);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: next } });
}

/** La base ne garde que le SHA-256 du jeton : une copie de la base ne donne pas de session valide. */
const sessionIdOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** @param mfaVerified connexion passée par la double authentification : seule une telle session sert par le tunnel. */
export async function createSession(userId: string, mfaVerified = false): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id: sessionIdOf(token), userId, expiresAt, lastSeenAt: new Date(), mfaVerified } });
  return { token, expiresAt };
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

/** Ferme la session du cookie, vérifiée ou non (rotation à la connexion, même par le tunnel). */
export async function destroySessionOfToken(token: string | undefined): Promise<void> {
  if (token) await destroySession(sessionIdOf(token));
}

export async function resolveSession(
  token: string | undefined,
): Promise<{ user: AuthUser; sessionId: string; mfaVerified: boolean } | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionIdOf(token) },
    include: { user: true },
  });
  if (!session) return null;
  const now = Date.now();
  // Session antérieure à lastSeenAt (null) : active jusqu'à sa prochaine requête. Une session ouverte
  // avant le passage à 7 jours expire à 7 jours de sa création, quelle que soit sa date d'expiration.
  const expired =
    session.expiresAt.getTime() < now ||
    session.createdAt.getTime() + SESSION_TTL_MS < now ||
    (session.lastSeenAt !== null && session.lastSeenAt.getTime() + SESSION_IDLE_MS < now);
  if (expired) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (!session.lastSeenAt || session.lastSeenAt.getTime() + SESSION_TOUCH_MS < now) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }
  return {
    sessionId: session.id,
    mfaVerified: session.mfaVerified,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  };
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  // Par le tunnel, la page est en HTTPS même si COOKIE_SECURE=false pour le LAN.
  const secure = getCookieSecure() || request.viaTunnel;
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  const secure = getCookieSecure() || request.viaTunnel;
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
  });
}

export async function attachUser(request: FastifyRequest): Promise<void> {
  const sid = request.cookies[SESSION_COOKIE];
  const resolved = await resolveSession(sid);
  // Par le tunnel, une session ouverte sans double authentification (mot de passe seul, en LAN) ne vaut rien : la
  // connexion avec le code est redemandée (décision d'Alexandre du 27/10/2026). En LAN, rien ne change.
  if (resolved && request.viaTunnel && !resolved.mfaVerified) return;
  if (resolved) {
    request.user = resolved.user;
    request.sessionId = resolved.sessionId;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await attachUser(request);
  if (!request.user) {
    const err = new Error("Non authentifié") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  void reply;
}
