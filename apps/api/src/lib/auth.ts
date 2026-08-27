import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@/lib/prisma.js";

export const SESSION_COOKIE = "kouzia_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

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

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id, userId, expiresAt } });
  return { id, expiresAt };
}

export async function destroySession(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function resolveSession(
  sessionId: string | undefined,
): Promise<{ user: AuthUser; sessionId: string } | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
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
