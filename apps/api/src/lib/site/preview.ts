import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { SiteProject } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { publicApiBaseUrl } from "@/lib/settings/public.js";
import { concernsClient, detailIssue, detailStarted, projectOut } from "@/lib/site/mapping.js";

/**
 * Aperçu du brouillon d'une réalisation sur la page /apercu du site (lot 5b, contrat validé avec le site le
 * 23/10/2026). Jeton signé (HMAC-SHA256, clé dérivée de SESSION_SECRET pour ce seul usage), valable 15 minutes,
 * jamais stocké : charge { p, exp, jti }, en base64url, suivie de sa signature.
 */
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

const key = () => Buffer.from(hkdfSync("sha256", process.env.SESSION_SECRET ?? "", "", "site-preview", 32));
const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest();

export function signPreviewToken(projectId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const exp = Math.floor((now + PREVIEW_TTL_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ p: projectId, exp, jti: randomBytes(12).toString("base64url") })).toString("base64url");
  return { token: `${payload}.${sign(payload).toString("base64url")}`, expiresAt: new Date(exp * 1000) };
}

/** Jeton valide et non expiré : réalisation visée et fin de validité ; null sinon (sans dire pourquoi). */
export function verifyPreviewToken(token: string | undefined, now = Date.now()): { projectId: string; expiresAt: Date } | null {
  const m = /^([A-Za-z0-9_-]{16,400})\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
  if (!m) return null;
  const given = Buffer.from(m[2]!, "base64url");
  const expected = sign(m[1]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { p, exp } = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as { p?: unknown; exp?: unknown };
    if (typeof p !== "string" || typeof exp !== "number" || exp * 1000 <= now) return null;
    return { projectId: p, expiresAt: new Date(exp * 1000) };
  } catch {
    return null;
  }
}

/** Ce qui empêche la réalisation (carte ou page projet) de partir à la prochaine publication. */
export function previewBlockers(p: SiteProject): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  if (p.status === "DRAFT") out.push({ code: "brouillon", message: "Brouillon : la réalisation ne part pas à la publication." });
  if (p.status === "WITHDRAWN") out.push({ code: "retiree", message: "Retirée du site : la réalisation ne part pas à la publication." });
  if (concernsClient(p) && !p.publicationConsentAt && !p.publishedAt) {
    out.push({ code: "accord-client", message: "Accord écrit du client à renseigner : la carte ne part pas." });
  }
  if (!detailStarted(p)) out.push({ code: "page-vide", message: "Page projet pas commencée : seule la carte part." });
  else {
    const issue = detailIssue(p);
    if (issue) out.push({ code: issue.code, message: `Page projet non publiée : ${issue.message}.` });
  }
  return out;
}

const MEDIA_PATH = /^\/media\/([a-f0-9]{12})\.webp$/;

/** Images de la médiathèque citées par l'aperçu de la réalisation (carte et page projet), par empreinte. */
export function previewMediaShas(realisation: ReturnType<typeof projectOut>): string[] {
  const d = realisation.detail;
  const paths = [
    realisation.image,
    realisation.imageMobile,
    ...(d?.captures ?? []).map((c) => c.image),
    ...(d?.avantApres ?? []).flatMap((x) => [x.avant.image, x.apres.image]),
  ];
  return [...new Set(paths.map((path) => MEDIA_PATH.exec(path ?? "")?.[1]).filter((s): s is string => Boolean(s)))];
}

/** Contenu de l'aperçu (réponse de GET /api/public/preview/realisation), null si la réalisation n'existe plus. */
export async function buildPreview(projectId: string, token: string, expiresAt: Date) {
  const p = await prisma.siteProject.findUnique({ where: { id: projectId } });
  if (!p) return null;
  // Même sérialisation que realisations.json (accord du client respecté), page projet rendue même incomplète.
  const realisation = projectOut(p, { preview: true });
  const shas = previewMediaShas(realisation);
  const rows = shas.length ? await prisma.siteMedia.findMany({ where: { sha12: { in: shas } }, select: { sha12: true, width: true, height: true, width2x: true } }) : [];
  const bySha = new Map(rows.map((r) => [r.sha12, r]));
  const src = (file: string) => `${publicApiBaseUrl()}/api/public/preview/media/${file}?jeton=${encodeURIComponent(token)}`;
  const media = Object.fromEntries(
    shas.map((sha) => {
      const row = bySha.get(sha);
      // Dimensions envoyées quand elles sont connues (le site accepte leur absence).
      return [
        `/media/${sha}.webp`,
        { src: src(`${sha}.webp`), ...(row ? { width: row.width, height: row.height } : {}), ...(row?.width2x ? { src2x: src(`${sha}-2x.webp`) } : {}) },
      ];
    }),
  );
  return { realisation, blockers: previewBlockers(p), media, expiresAt: expiresAt.toISOString(), generatedAt: new Date().toISOString() };
}
