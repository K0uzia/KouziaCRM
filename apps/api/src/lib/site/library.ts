import { SitePublicationStatus, SiteMediaKind, type SiteMedia } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { lastPublishedFiles } from "@/lib/site/changes.js";
import { removeSiteMediaFiles, renderFromOriginal, siteMediaPublicPath, adoptPublishedImage, type Focal } from "@/lib/site/media.js";

/**
 * Médiathèque de l'espace Site : où chaque image sert, ce qui est en ligne, suppression protégée et recadrage.
 * Règle : une image citée par la dernière publication reste dans l'ERP (fichiers et ligne) jusqu'à la publication
 * suivante, même remplacée ou recadrée ; ainsi un retour en arrière avant de publier ne casse aucun lien.
 */

export type MediaUsage = { label: string; to: string; field: "imagePath" | "imageMobilePath" | "logoPath" };

const MEDIA_IN_TEXT = /\/media\/([a-f0-9]{12})\.webp/g;
const shaOf = (path: string | null) => /^\/media\/([a-f0-9]{12})\.webp$/.exec(path ?? "")?.[1] ?? null;

/** Où chaque image est utilisée (réalisations et références, brouillons compris). */
export async function mediaUsages(): Promise<Map<string, MediaUsage[]>> {
  const [projects, references] = await Promise.all([
    prisma.siteProject.findMany({ select: { id: true, name: true, imagePath: true, imageMobilePath: true } }),
    prisma.siteReference.findMany({ select: { name: true, logoPath: true } }),
  ]);
  const usages = new Map<string, MediaUsage[]>();
  const add = (path: string | null, usage: MediaUsage) => {
    const sha = shaOf(path);
    if (sha) usages.set(sha, [...(usages.get(sha) ?? []), usage]);
  };
  for (const p of projects) {
    add(p.imagePath, { label: `Capture de « ${p.name} »`, to: `/site/realisations/${p.id}`, field: "imagePath" });
    add(p.imageMobilePath, { label: `Capture de téléphone de « ${p.name} »`, to: `/site/realisations/${p.id}`, field: "imageMobilePath" });
  }
  for (const r of references) add(r.logoPath, { label: `Logo de « ${r.name} »`, to: "/site/references", field: "logoPath" });
  return usages;
}

/**
 * Images citées par la dernière publication arrivée dans le dépôt. null : le site a été publié avant le suivi des
 * fichiers publiés, on ne sait donc pas ce qui est en ligne.
 */
export async function onlineMedia(): Promise<Set<string> | null> {
  const files = await lastPublishedFiles();
  if (!files) {
    const published = await prisma.sitePublication.count({ where: { OR: [{ commitSha: { not: null } }, { status: SitePublicationStatus.NOOP }] } });
    return published ? null : new Set();
  }
  return new Set(Object.values(files).flatMap((text) => [...text.matchAll(MEDIA_IN_TEXT)].map((m) => m[1]!)));
}

export type LibraryItem = SiteMedia & {
  path: string;
  usages: MediaUsage[];
  /** Citée par la dernière publication : en ligne sur kouzia.com. null : inconnu. */
  online: boolean | null;
  /** Ancienne version d'une image recadrée, gardée tant qu'elle est en ligne. */
  previousVersion: boolean;
};

export async function listLibrary(): Promise<LibraryItem[]> {
  const [rows, usages, online] = await Promise.all([
    prisma.siteMedia.findMany({ orderBy: { createdAt: "desc" } }),
    mediaUsages(),
    onlineMedia(),
  ]);
  // Version la plus récente de chaque original : les autres, inutilisées, sont d'anciennes versions recadrées.
  const latest = new Map<string, Date>();
  for (const m of rows) {
    if (m.originalPath && !(latest.get(m.originalPath)! > m.createdAt)) latest.set(m.originalPath, m.createdAt);
  }
  return rows.map((m) => {
    const used = usages.get(m.sha12) ?? [];
    return {
      ...m,
      path: siteMediaPublicPath(m.sha12),
      usages: used,
      online: online ? online.has(m.sha12) : null,
      previousVersion: !used.length && Boolean(m.originalPath && latest.get(m.originalPath)! > m.createdAt),
    };
  });
}

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

/** Raison pour laquelle une image ne peut pas être supprimée, null si elle le peut. */
export async function deletionBlocker(media: SiteMedia): Promise<string | null> {
  const used = (await mediaUsages()).get(media.sha12) ?? [];
  if (used.length) return `Utilisée par : ${used.map((u) => u.label).join(", ")}. La retirer de ces fiches d'abord.`;
  const online = await onlineMedia();
  if (!online) return "Le site a été publié avant le suivi des images : publier une fois, puis supprimer.";
  if (online.has(media.sha12)) return "Encore en ligne sur kouzia.com : supprimable après la prochaine publication.";
  return null;
}

/** Supprime une image inutilisée et absente de la dernière publication : 1x, 2x et original non partagé. */
export async function deleteLibraryMedia(id: string): Promise<void> {
  const media = await prisma.siteMedia.findUnique({ where: { id } });
  if (!media) throw new LibraryError("Image introuvable", 404);
  const blocker = await deletionBlocker(media);
  if (blocker) throw new LibraryError(blocker, 409);
  await prisma.siteMedia.delete({ where: { id } });
  await removeSiteMediaFiles(media);
}

/**
 * Recadre une image autour d'un point d'intérêt : nouvelle version (nouvelle empreinte), fiches qui l'utilisent
 * repointées (elles deviennent « Modifié »). L'ancienne version reste tant qu'elle est en ligne, sinon disparaît.
 */
export async function recropLibraryMedia(id: string, focal: Focal): Promise<SiteMedia> {
  const media = await prisma.siteMedia.findUnique({ where: { id } });
  if (!media) throw new LibraryError("Image introuvable", 404);
  const next = await renderFromOriginal(media, focal);
  if (next.id === media.id) return next;
  const from = siteMediaPublicPath(media.sha12);
  const to = siteMediaPublicPath(next.sha12);
  await prisma.$transaction([
    prisma.siteProject.updateMany({ where: { imagePath: from }, data: { imagePath: to } }),
    prisma.siteProject.updateMany({ where: { imageMobilePath: from }, data: { imageMobilePath: to } }),
    prisma.siteReference.updateMany({ where: { logoPath: from }, data: { logoPath: to } }),
  ]);
  if (!(await deletionBlocker(media))) {
    await prisma.siteMedia.delete({ where: { id: media.id } });
    await removeSiteMediaFiles(media);
  }
  return next;
}

/** Après une publication : retire les anciennes versions recadrées qui ne sont plus en ligne. */
export async function purgePreviousVersions(): Promise<number> {
  const online = await onlineMedia();
  if (!online) return 0;
  const stale = (await listLibrary()).filter((m) => m.previousVersion && !online.has(m.sha12));
  for (const m of stale) {
    await prisma.siteMedia.delete({ where: { id: m.id } });
    await removeSiteMediaFiles(m);
  }
  return stale.length;
}

const KIND_BY_FIELD: Record<MediaUsage["field"], SiteMediaKind> = {
  imagePath: SiteMediaKind.CAPTURE,
  imageMobilePath: SiteMediaKind.MOBILE,
  logoPath: SiteMediaKind.LOGO,
};

/**
 * Reprise du site : les images citées mais absentes de l'ERP sont copiées depuis le dépôt (public/media/), telles
 * que publiées, si leur contenu correspond bien à leur nom. Sans original : non recadrables, mais publiables.
 * read : lecture d'un fichier du dépôt, null s'il n'existe pas. Renvoie le nombre d'images reprises.
 */
export async function adoptMissingMedia(read: (path: string) => Promise<Buffer | null>): Promise<number> {
  const usages = await mediaUsages();
  const known = new Set((await prisma.siteMedia.findMany({ select: { sha12: true } })).map((m) => m.sha12));
  let adopted = 0;
  for (const [sha12, used] of usages) {
    if (known.has(sha12)) continue;
    const x1 = await read(`public/media/${sha12}.webp`);
    if (!x1) continue;
    const x2 = await read(`public/media/${sha12}-2x.webp`);
    if (await adoptPublishedImage(sha12, KIND_BY_FIELD[used[0]!.field], x1, x2, used[0]!.label)) adopted++;
  }
  return adopted;
}
