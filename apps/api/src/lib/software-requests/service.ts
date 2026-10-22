import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { decrypt, decryptOptional, encrypt, encryptOptional } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

/**
 * Demandes d'utilisation d'un logiciel (Tracebay) depuis le site (contrat du 22/10/2026 avec KouziaWebsite).
 * Base légale : mesures précontractuelles (art. 6.1.b RGPD), mention d'information versionnée (noticeVersion).
 */
export const SOFTWARE = { tracebay: "TRACEBAY" } as const;
export const EDITIONS = ["SERVER", "PORTABLE", "UNSURE"] as const;
export const SEATS = ["1", "2_5", "6_20", "20_PLUS"] as const;
export const DURATIONS = ["3_MONTHS", "6_MONTHS", "12_MONTHS", "UNSURE"] as const;
export const REQUEST_STATUSES = ["PENDING", "CONVERTED", "DECLINED"] as const;

/** Délai minimal entre l'affichage du formulaire (jeton) et l'envoi : en dessous, robot présumé. */
export const MIN_FILL_MS = 3_000;
/** Durée de vie d'un jeton de formulaire. */
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/** Même e-mail et même logiciel, demande en attente de moins de 24 h : on complète au lieu d'en créer une. */
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const submitSchema = z.strictObject({
  software: z.enum(["tracebay"]),
  company: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^\+?[0-9 .()-]{6,30}$/)
    .optional()
    .or(z.literal("")),
  edition: z.enum(EDITIONS),
  seats: z.enum(SEATS),
  need: z.string().trim().min(10).max(2000),
  duration: z.enum(DURATIONS),
  noticeVersion: z.string().regex(/^[0-9a-f]{12}$/),
  token: z.string().max(200),
  /** Pot de miel : doit rester vide. */
  website: z.string().max(500).optional(),
});
export type SubmitInput = z.infer<typeof submitSchema>;

/** Clé propre aux jetons de formulaire, dérivée de SESSION_SECRET (jamais la clé des cookies elle-même). */
function key(): Buffer {
  const s = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!s) throw new Error("SESSION_SECRET requis pour signer les jetons de formulaire");
  return createHmac("sha256", s).update("kouzia-form-token-v1").digest();
}

const sign = (issuedAt: string) => createHmac("sha256", key()).update(issuedAt).digest("base64url");

/** Jeton sans état : horodatage d'affichage du formulaire, signé. */
export function issueFormToken(now = Date.now()): string {
  const issuedAt = String(now);
  return `${issuedAt}.${sign(issuedAt)}`;
}

export type TokenCheck = { ok: true; ageMs: number } | { ok: false };

export function checkFormToken(token: string, now = Date.now()): TokenCheck {
  const [issuedAt, mac] = token.split(".");
  if (!issuedAt || !mac || !/^\d{10,16}$/.test(issuedAt)) return { ok: false };
  const expected = Buffer.from(sign(issuedAt));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  const ageMs = now - Number(issuedAt);
  if (ageMs < 0 || ageMs > TOKEN_TTL_MS) return { ok: false };
  return { ok: true, ageMs };
}

/** Enregistre la demande, ou complète celle du même demandeur déposée il y a moins de 24 h. */
export async function submitSoftwareRequest(input: SubmitInput, now = new Date()): Promise<{ id: string; created: boolean }> {
  const software = SOFTWARE[input.software];
  const emailHash = computeEmailHash(input.email)!;
  const data = {
    companyName: input.company,
    contactNameEncrypted: encrypt(input.name),
    emailEncrypted: encrypt(input.email),
    phoneEncrypted: encryptOptional(input.phone || null),
    edition: input.edition,
    seats: input.seats,
    need: input.need,
    duration: input.duration,
    noticeVersion: input.noticeVersion,
  };
  const recent = await prisma.softwareRequest.findFirst({
    where: { software, emailHash, status: "PENDING", createdAt: { gt: new Date(now.getTime() - DUPLICATE_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (recent) {
    await prisma.softwareRequest.update({ where: { id: recent.id }, data });
    return { id: recent.id, created: false };
  }
  const row = await prisma.softwareRequest.create({ data: { ...data, software, emailHash } });
  return { id: row.id, created: true };
}

type Row = Awaited<ReturnType<typeof prisma.softwareRequest.findUniqueOrThrow>>;

/** Liste : sans e-mail ni téléphone (ils ne s'affichent que sur la fiche). */
export function serializeListItem(r: Row & { client?: { id: string; displayName: string } | null }) {
  return {
    id: r.id,
    software: r.software,
    status: r.status,
    companyName: r.companyName,
    contactName: decrypt(r.contactNameEncrypted),
    seats: r.seats,
    duration: r.duration,
    client: r.client ? { id: r.client.id, displayName: r.client.displayName } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function getSoftwareRequest(id: string) {
  const r = await prisma.softwareRequest.findUnique({ where: { id }, include: { client: { select: { id: true, displayName: true } } } });
  if (!r) return null;
  // Client déjà connu par son e-mail : rattachement proposé (jamais automatique).
  const match = r.clientId
    ? null
    : await prisma.client.findFirst({ where: { emailHash: r.emailHash }, select: { id: true, displayName: true, clientNumber: true } });
  return {
    ...serializeListItem(r),
    email: decrypt(r.emailEncrypted),
    phone: decryptOptional(r.phoneEncrypted),
    edition: r.edition,
    need: r.need,
    noticeVersion: r.noticeVersion,
    convertedAt: r.convertedAt?.toISOString() ?? null,
    declinedAt: r.declinedAt?.toISOString() ?? null,
    suggestedClient: match,
  };
}

export class RequestStateError extends Error {}

/** Rattache la demande à un client (créé depuis la fiche, ou existant) : elle passe convertie. */
export async function linkSoftwareRequest(id: string, clientId: string, now = new Date()) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new RequestStateError("Client introuvable.");
  const done = await prisma.softwareRequest.updateMany({
    where: { id, status: { not: "CONVERTED" } },
    data: { status: "CONVERTED", clientId, convertedAt: now, declinedAt: null },
  });
  if (done.count === 0) throw new RequestStateError("Demande introuvable ou déjà convertie.");
}

export async function declineSoftwareRequest(id: string, now = new Date()) {
  const done = await prisma.softwareRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "DECLINED", declinedAt: now },
  });
  if (done.count === 0) throw new RequestStateError("Demande introuvable ou déjà traitée.");
}
