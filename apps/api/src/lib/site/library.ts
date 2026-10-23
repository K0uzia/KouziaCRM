import { SitePublicationStatus, SiteMediaKind, type SiteMedia } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { lastPublishedFiles } from "@/lib/site/changes.js";
import { SITE_PAGE_IDS, SITE_PAGE_LABEL } from "@/lib/site/contract.js";
import { readSiteText, writeSiteText } from "@/lib/site/texts.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { parseJsonList, type ProjectBeforeAfter, type ProjectCapture } from "@/lib/site/mapping.js";
import {
  loadSharp,
  removeSiteMediaFiles,
  renderFromOriginal,
  siteMediaExt,
  siteMediaPublicPath,
  adoptPublishedImage,
  SITE_MEDIA_PATH_RE,
  type Focal,
} from "@/lib/site/media.js";

/**
 * Médiathèque de l'espace Site : où chaque image sert, ce qui est en ligne, suppression protégée et recadrage.
 * Règle : une image citée par la dernière publication reste dans l'ERP (fichiers et ligne) jusqu'à la publication
 * suivante, même remplacée ou recadrée ; ainsi un retour en arrière avant de publier ne casse aucun lien.
 */

export type MediaUsage = {
  label: string;
  to: string;
  field: "imagePath" | "imageMobilePath" | "logoPath" | "seoImage" | "captures" | "avantApres";
  /** Type attendu à cet endroit (reprise d'une image absente de l'ERP). */
  mediaKind: SiteMediaKind;
  /** Avant / après : l'autre image de la paire, pour recadrer au même format. */
  pairPath?: string;
};

const MEDIA_IN_TEXT = /\/media\/([a-f0-9]{12})\.(?:webp|jpg)/g;
const shaOf = (path: string | null) => SITE_MEDIA_PATH_RE.exec(path ?? "")?.[1] ?? null;
/** Chemin publié d'une image, avec l'extension de son type. */
export const libraryPath = (m: Pick<SiteMedia, "sha12" | "kind">) => siteMediaPublicPath(m.sha12, siteMediaExt(m.kind));

/** Où chaque image est utilisée (réalisations, références et référencement des pages, brouillons compris). */
export async function mediaUsages(): Promise<Map<string, MediaUsage[]>> {
  const [projects, references, seo] = await Promise.all([
    prisma.siteProject.findMany({ select: { id: true, name: true, imagePath: true, imageMobilePath: true, capturesJson: true, avantApresJson: true } }),
    prisma.siteReference.findMany({ select: { id: true, name: true, logoPath: true } }),
    readSiteText("seo"),
  ]);
  const usages = new Map<string, MediaUsage[]>();
  const add = (path: string | null, usage: MediaUsage) => {
    const sha = shaOf(path);
    if (sha) usages.set(sha, [...(usages.get(sha) ?? []), usage]);
  };
  for (const p of projects) {
    const to = `/site/realisations/${p.id}`;
    add(p.imagePath, { label: `Capture de « ${p.name} »`, to, field: "imagePath", mediaKind: SiteMediaKind.CAPTURE });
    add(p.imageMobilePath, { label: `Capture de téléphone de « ${p.name} »`, to, field: "imageMobilePath", mediaKind: SiteMediaKind.MOBILE });
    // Page projet : captures et avant / après (detail.captures, detail.avantApres).
    parseJsonList<ProjectCapture>(p.capturesJson).forEach((c, i) =>
      add(c.image, {
        label: `Capture ${i + 1} de la page projet « ${p.name} »`,
        to: `${to}?tab=page`,
        field: "captures",
        mediaKind: c.vue === "mobile" ? SiteMediaKind.MOBILE : SiteMediaKind.CAPTURE,
      }),
    );
    for (const x of parseJsonList<ProjectBeforeAfter>(p.avantApresJson)) {
      const mediaKind = x.vue === "mobile" ? SiteMediaKind.MOBILE : SiteMediaKind.CAPTURE;
      const view = x.vue === "mobile" ? "téléphone" : "ordinateur";
      add(x.avant.image, { label: `Avant (${view}) de « ${p.name} »`, to: `${to}?tab=page`, field: "avantApres", mediaKind, pairPath: x.apres.image });
      add(x.apres.image, { label: `Après (${view}) de « ${p.name} »`, to: `${to}?tab=page`, field: "avantApres", mediaKind, pairPath: x.avant.image });
    }
  }
  for (const r of references) add(r.logoPath, { label: `Logo de « ${r.name} »`, to: `/site/references/${r.id}`, field: "logoPath", mediaKind: SiteMediaKind.LOGO });
  for (const id of SITE_PAGE_IDS) {
    add(seo?.pages[id]?.image ?? null, {
      label: `Image de partage de la page « ${SITE_PAGE_LABEL[id]} »`,
      to: `/site/tous-les-textes?page=${id}`,
      field: "seoImage",
      mediaKind: SiteMediaKind.PARTAGE,
    });
  }
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
  /** Avant / après : format de l'autre image de chaque paire (« l:h »), pour recadrer au même ratio. */
  pairFormats: Array<{ label: string; ratio: string }>;
  /** Capture recadrée d'office en 16:9 ou 9:19,5 (avant le 23/10/2026), régénérable sans recadrage depuis l'original. */
  regenerable: boolean;
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
  const bySha = new Map(rows.map((m) => [m.sha12, m]));
  const items = rows.map((m) => {
    const used = usages.get(m.sha12) ?? [];
    const pairFormats = used.flatMap((u) => {
      const other = u.pairPath ? bySha.get(shaOf(u.pairPath) ?? "") : undefined;
      return other ? [{ label: u.label, ratio: `${other.width}:${other.height}` }] : [];
    });
    return {
      ...m,
      path: libraryPath(m),
      usages: used,
      online: online ? online.has(m.sha12) : null,
      previousVersion: !used.length && Boolean(m.originalPath && latest.get(m.originalPath)! > m.createdAt),
      pairFormats,
      regenerable: false,
    };
  });
  const candidates = items.filter((m) => !m.previousVersion && legacyFramed(m));
  const flags = await Promise.all(candidates.map((m) => originalDiffersFromFrame(m)));
  candidates.forEach((m, i) => (m.regenerable = flags[i]!));
  return items;
}

/** Cadres figés des captures avant le 23/10/2026 : 960×540 (ordinateur) et 390×844 (téléphone), recadrés d'office. */
const LEGACY_FRAMES: Partial<Record<SiteMediaKind, { width: number; height: number }>> = {
  CAPTURE: { width: 960, height: 540 },
  MOBILE: { width: 390, height: 844 },
};
const legacyFramed = (m: SiteMedia) => {
  const frame = LEGACY_FRAMES[m.kind];
  return Boolean(frame && m.originalPath && !m.cropRatio && m.width === frame.width && m.height === frame.height);
};

/** L'original n'a pas le ratio du cadre figé : la version publiée en a été coupée. Original illisible : non. */
async function originalDiffersFromFrame(m: SiteMedia): Promise<boolean> {
  const frame = LEGACY_FRAMES[m.kind];
  const sharp = await loadSharp();
  if (!frame || !sharp || !m.originalPath) return false;
  try {
    const meta = await sharp(issuedPdfAbsolutePath(m.originalPath)).metadata();
    return Boolean(meta.width && meta.height && meta.width * frame.height !== meta.height * frame.width);
  } catch {
    return false;
  }
}

/**
 * Remplace une version par une autre partout où elle sert (fiches, page projet, référencement) : les fiches
 * deviennent « Modifié ». L'ancienne version reste tant qu'elle est en ligne, sinon disparaît.
 */
async function replaceEverywhere(media: SiteMedia, next: SiteMedia): Promise<void> {
  const from = libraryPath(media);
  const to = libraryPath(next);
  const inJson = await prisma.siteProject.findMany({
    where: { OR: [{ capturesJson: { contains: from } }, { avantApresJson: { contains: from } }] },
    select: { id: true, capturesJson: true, avantApresJson: true },
  });
  // Chemin exact entre guillemets : /media/<sha12>.webp n'est le préfixe d'aucun autre chemin.
  const swap = (json: string | null) => json?.replaceAll(JSON.stringify(from), JSON.stringify(to)) ?? null;
  await prisma.$transaction([
    prisma.siteProject.updateMany({ where: { imagePath: from }, data: { imagePath: to } }),
    prisma.siteProject.updateMany({ where: { imageMobilePath: from }, data: { imageMobilePath: to } }),
    prisma.siteReference.updateMany({ where: { logoPath: from }, data: { logoPath: to } }),
    ...inJson.map((p) => prisma.siteProject.update({ where: { id: p.id }, data: { capturesJson: swap(p.capturesJson), avantApresJson: swap(p.avantApresJson) } })),
  ]);
  // Référencement : chaque page qui citait l'ancienne version passe à la nouvelle.
  const seo = await readSiteText("seo");
  if (seo && SITE_PAGE_IDS.some((id) => seo.pages[id]?.image === from)) {
    const pages = Object.fromEntries(Object.entries(seo.pages).map(([id, p]) => [id, p?.image === from ? { ...p, image: to } : p]));
    await writeSiteText("seo", { pages });
  }
  if (!(await deletionBlocker(media))) {
    await prisma.siteMedia.delete({ where: { id: media.id } });
    await removeSiteMediaFiles(media);
  }
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
 * Nouvelle version d'une image (nouvelle empreinte), fiches qui l'utilisent repointées. Image de partage : recadrée
 * autour du point d'intérêt. Capture : au format choisi (cropRatio) autour du point d'intérêt, ou au format
 * d'origine sans recadrage (cropRatio nul).
 */
export async function recropLibraryMedia(id: string, focal: Focal | null, cropRatio: string | null = null): Promise<SiteMedia> {
  const media = await prisma.siteMedia.findUnique({ where: { id } });
  if (!media) throw new LibraryError("Image introuvable", 404);
  const next = await renderFromOriginal(media, focal, cropRatio);
  if (next.id !== media.id) await replaceEverywhere(media, next);
  return next;
}

/** Régénère sans recadrage toutes les captures coupées d'office : renvoie le nombre de captures traitées. */
export async function regenerateFramedCaptures(): Promise<number> {
  const targets = (await listLibrary()).filter((m) => m.regenerable);
  // Une à une : sharp traite une image à la fois ; un rendu identique corrige seulement les dimensions enregistrées.
  for (const m of targets) await recropLibraryMedia(m.id, null, null);
  return targets.length;
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
    const kind = used[0]!.mediaKind;
    // Image de partage : un JPEG unique ; les autres : WebP 1x et 2x.
    const ext = siteMediaExt(kind);
    const x1 = await read(`public/media/${sha12}.${ext}`);
    if (!x1) continue;
    const x2 = ext === "webp" ? await read(`public/media/${sha12}-2x.webp`) : null;
    if (await adoptPublishedImage(sha12, kind, x1, x2, used[0]!.label)) adopted++;
  }
  return adopted;
}
