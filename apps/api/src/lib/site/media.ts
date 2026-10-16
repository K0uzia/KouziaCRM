import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SiteMediaKind, type SiteMedia } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";

/**
 * Images de l'espace Site : normalisées en WebP sans métadonnées (EXIF et position GPS retirés), en deux
 * largeurs, sous data/uploads/site/. Exception : l'image de partage (og:image), un JPEG unique de 1200×630, format
 * le mieux lu par les réseaux sociaux. L'original est conservé sous site/originaux/ pour recadrer plus tard,
 * lui aussi réécrit sans métadonnées et ramené à ORIGINAL_MAX_SIDE px au plus ; le fichier envoyé tel quel
 * n'est jamais écrit sur disque.
 * sharp est chargé à la demande : sans son binaire, l'API démarre et seul l'envoi d'image est refusé.
 */

export const SITE_MEDIA_DIR = "site";
export const SITE_MEDIA_MAX_INPUT_BYTES = 15 * 1024 * 1024;
/** Plus grand côté de l'original conservé : assez pour la version 2x de chaque format, borne le disque (quelques Mo). */
export const ORIGINAL_MAX_SIDE = 4000;
const ORIGINALS_DIR = `${SITE_MEDIA_DIR}/originaux`;

export type Focal = { x: number; y: number };
type SniffedType = "jpeg" | "png" | "webp" | "avif" | "heif" | "svg";

/**
 * Type réel d'un fichier d'après ses premiers octets, quelle que soit son extension.
 * Écrit ici : cinq signatures connues, sharp décode ensuite et doit trouver le même format.
 */
export function sniffImageType(input: Buffer): SniffedType | null {
  const ascii = (start: number, end: number) => input.subarray(start, end).toString("latin1");
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return "jpeg";
  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (input.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (input.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heif";
  }
  if (/^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(input.subarray(0, 4096).toString("utf8"))) return "svg";
  return null;
}
/** Format annoncé par sharp pour chaque type reconnu (AVIF et HEIF partagent le conteneur « heif »). */
const SHARP_FORMAT: Record<SniffedType, string[]> = {
  jpeg: ["jpeg"],
  png: ["png"],
  webp: ["webp"],
  avif: ["heif", "avif"],
  heif: ["heif"],
  svg: ["svg"],
};

/**
 * Zone gardée d'une image de largeur w et hauteur h pour un cadre de proportion ratio, centrée au plus près du
 * point d'intérêt (0 à 1 depuis le coin haut gauche) sans sortir de l'image.
 */
export function focalCrop(w: number, h: number, ratio: number, focal: Focal): { left: number; top: number; width: number; height: number } {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  if (w / h > ratio) {
    const width = Math.min(w, Math.round(h * ratio));
    return { left: clamp(Math.round(focal.x * w - width / 2), w - width), top: 0, width, height: h };
  }
  const height = Math.min(h, Math.round(w / ratio));
  return { left: 0, top: clamp(Math.round(focal.y * h - height / 2), h - height), width: w, height };
}

type Variant = { width: number; height?: number; maxBytes: number; position?: "attention" | "top" };
const VARIANTS: Record<SiteMediaKind, { x1: Variant; x2: Variant | null }> = {
  // Capture 16:9, affichée en 960×540 sur le site.
  CAPTURE: { x1: { width: 960, height: 540, maxBytes: 150_000 }, x2: { width: 1920, height: 1080, maxBytes: 300_000 } },
  // Capture de téléphone 9:19,5, recadrée par le haut : le haut de page reste, le bas d'une page plus longue est coupé.
  MOBILE: {
    x1: { width: 390, height: 844, maxBytes: 150_000, position: "top" },
    x2: { width: 780, height: 1688, maxBytes: 150_000, position: "top" },
  },
  LOGO: { x1: { width: 200, maxBytes: 30_000 }, x2: { width: 400, maxBytes: 60_000 } },
  // Image de partage : taille fixe imposée par og:image, sans version 2x ; 300 Ko au plus (contrôle du build du site).
  PARTAGE: { x1: { width: 1200, height: 630, maxBytes: 300_000 }, x2: null },
};

export type SiteMediaExt = "webp" | "jpg";
/** Extension publiée d'un type d'image : JPEG pour le partage, WebP sinon. */
export const siteMediaExt = (kind: SiteMediaKind): SiteMediaExt => (kind === SiteMediaKind.PARTAGE ? "jpg" : "webp");
/** Chemin publié d'une image du site : /media/<sha12>.webp ou .jpg (capture : sha12 et extension). */
export const SITE_MEDIA_PATH_RE = /^\/media\/([a-f0-9]{12})\.(webp|jpg)$/;
const QUALITIES = [80, 72, 64, 56, 48];
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "avif", "heif"]);

/**
 * Logo SVG : accepté puis RASTÉRISÉ en WebP (aucun SVG ne part vers le site). Avant le rendu, refus de tout
 * ce qui ferait lire une ressource externe ou locale par le moteur SVG (image, lien, feuille de style,
 * entité XML) : seules les références internes (#id) sont permises.
 */
export function assertSafeSvg(input: Buffer): void {
  const text = input.toString("utf8");
  const forbidden = [
    /<!ENTITY/i,
    /<!DOCTYPE[^>]*\[/i,
    /<\s*(image|foreignObject|script|iframe|use)\b[^>]*\b(xlink:)?href\s*=\s*["'](?!#)/i,
    /<\s*(script|foreignObject|iframe)\b/i,
    /\b(xlink:)?href\s*=\s*["'](?!#)/i,
    /url\(\s*["']?(?!#)/i,
    /@import/i,
  ];
  if (forbidden.some((re) => re.test(text))) {
    throw new SiteMediaError(
      "SVG refusé : il fait appel à un fichier, un lien ou un script. Exporter le logo en SVG simple ou en PNG.",
      "FORMAT",
    );
  }
}

export class SiteMediaError extends Error {
  constructor(
    message: string,
    readonly code: "UNAVAILABLE" | "FORMAT" | "TOO_SMALL" | "TOO_HEAVY",
  ) {
    super(message);
  }
}

type SharpModule = typeof import("sharp");
let sharpPromise: Promise<SharpModule["default"] | null> | null = null;

/** sharp, configuré pour ménager la mémoire du serveur ; null si son binaire manque. */
export function loadSharp(): Promise<SharpModule["default"] | null> {
  sharpPromise ??= import("sharp")
    .then((m) => {
      m.default.concurrency(1);
      m.default.cache(false);
      return m.default;
    })
    .catch((err) => {
      console.error("[site] sharp indisponible : envoi d'images désactivé.", err instanceof Error ? err.message : err);
      return null;
    });
  return sharpPromise;
}

export const siteMediaRelativePath = (sha12: string, x2 = false, ext: SiteMediaExt = "webp") => `${SITE_MEDIA_DIR}/${sha12}${x2 ? "-2x" : ""}.${ext}`;
export const siteMediaPublicPath = (sha12: string, ext: SiteMediaExt = "webp") => `/media/${sha12}.${ext}`;

export type ProcessedImage = { buffer: Buffer; width: number; height: number };

/** Normalise une image envoyée : version 1x obligatoire, 2x seulement si la source est assez grande. */
export async function normalizeSiteImage(
  input: Buffer,
  kind: SiteMediaKind,
  focal: Focal | null = null,
): Promise<{ x1: ProcessedImage; x2: ProcessedImage | null; type: SniffedType }> {
  const sharp = await loadSharp();
  if (!sharp) throw new SiteMediaError("Traitement d'image indisponible sur ce serveur (sharp manquant).", "UNAVAILABLE");
  const type = sniffImageType(input);
  if (!type || (type === "svg" && kind !== SiteMediaKind.LOGO)) {
    throw new SiteMediaError(
      kind === SiteMediaKind.LOGO
        ? "Ce fichier n'est pas une image PNG, SVG, WebP, JPEG ou AVIF, quelle que soit son extension."
        : "Ce fichier n'est pas une image JPEG, PNG, WebP ou AVIF, quelle que soit son extension.",
      "FORMAT",
    );
  }
  const isSvg = type === "svg";
  if (isSvg) assertSafeSvg(input);
  // SVG : rendu assez dense pour obtenir la version 2x d'un logo dessiné petit (viewBox de 100 px).
  let density: number | undefined;
  const open = () => sharp(input, { limitInputPixels: 50_000_000, failOn: "error", ...(density ? { density } : {}) });
  let meta: Awaited<ReturnType<ReturnType<typeof open>["metadata"]>>;
  try {
    meta = await open().metadata();
    const logo2x = VARIANTS.LOGO.x2!.width;
    if (isSvg && meta.width && meta.width < logo2x) {
      density = Math.min(2400, Math.ceil((72 * logo2x) / meta.width));
      meta = await open().metadata();
    }
  } catch {
    throw new SiteMediaError("Fichier illisible : envoyer une image JPEG, PNG, WebP, AVIF ou un logo SVG.", "FORMAT");
  }
  if (!meta.format || !(ACCEPTED_FORMATS.has(meta.format) || (isSvg && meta.format === "svg"))) {
    throw new SiteMediaError(
      kind === SiteMediaKind.LOGO ? "Formats acceptés : PNG, SVG, WebP, JPEG, AVIF." : "Formats acceptés : JPEG, PNG, WebP, AVIF.",
      "FORMAT",
    );
  }
  if (!SHARP_FORMAT[type].includes(meta.format)) {
    throw new SiteMediaError("Fichier incohérent : son contenu ne correspond pas à un format d'image accepté.", "FORMAT");
  }
  const base = open;
  // Dimensions affichées, une fois l'orientation EXIF appliquée.
  const rotated = (meta.orientation ?? 1) >= 5;
  const srcWidth = (rotated ? meta.height : meta.width) ?? 0;
  const srcHeight = (rotated ? meta.width : meta.height) ?? 0;
  const { x1, x2 } = VARIANTS[kind];
  const jpeg = siteMediaExt(kind) === "jpg";
  if (srcWidth < x1.width || (x1.height && srcHeight < x1.height)) {
    throw new SiteMediaError(
      `Image trop petite : ${x1.width}${x1.height ? `×${x1.height}` : ""} px au moins (reçu ${srcWidth}×${srcHeight}).`,
      "TOO_SMALL",
    );
  }
  const render = async (v: Variant): Promise<ProcessedImage> => {
    for (const quality of QUALITIES) {
      // Sans withMetadata : sharp n'écrit aucune métadonnée (EXIF, GPS, ICC personnalisé).
      // Point d'intérêt choisi : zone gardée calculée ici, puis mise à la taille exacte du cadre.
      const crop = focal && v.height ? focalCrop(srcWidth, srcHeight, v.width / v.height, focal) : null;
      const pipeline = crop ? base().rotate().extract(crop) : base().rotate();
      const resized = pipeline.resize(
        v.height
          ? { width: v.width, height: v.height, fit: "cover", position: v.position ?? "attention" }
          : { width: v.width, fit: "inside", withoutEnlargement: true },
      );
      // JPEG sans transparence : fond blanc sous les zones transparentes (PNG), plutôt que du noir.
      const encoded = jpeg ? resized.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }) : resized.webp({ quality, effort: 4 });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      if (data.length <= v.maxBytes) return { buffer: data, width: info.width, height: info.height };
    }
    throw new SiteMediaError(
      `Image trop lourde même compressée (plus de ${Math.round(v.maxBytes / 1000)} Ko) : choisir une image plus simple.`,
      "TOO_HEAVY",
    );
  };
  const first = await render(x1);
  const bigEnough = x2 !== null && srcWidth >= x2.width && (!x2.height || srcHeight >= x2.height);
  return { x1: first, x2: bigEnough ? await render(x2) : null, type };
}

/**
 * Original à conserver : orientation appliquée, sans aucune métadonnée (EXIF, GPS, XMP), plus grand côté borné.
 * Un SVG (logo) est gardé tel quel : déjà contrôlé par assertSafeSvg, il ne porte pas d'EXIF.
 */
export async function cleanOriginal(input: Buffer, type: SniffedType): Promise<{ buffer: Buffer; ext: string }> {
  if (type === "svg") return { buffer: input, ext: "svg" };
  const sharp = await loadSharp();
  if (!sharp) throw new SiteMediaError("Traitement d'image indisponible sur ce serveur (sharp manquant).", "UNAVAILABLE");
  const img = sharp(input, { limitInputPixels: 50_000_000, failOn: "error" })
    .rotate()
    .resize({ width: ORIGINAL_MAX_SIDE, height: ORIGINAL_MAX_SIDE, fit: "inside", withoutEnlargement: true });
  if (type === "png") return { buffer: await img.png({ compressionLevel: 9 }).toBuffer(), ext: "png" };
  if (type === "webp") return { buffer: await img.webp({ quality: 92 }).toBuffer(), ext: "webp" };
  return { buffer: await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer(), ext: "jpg" };
}

const mediaSha = (x1: Buffer) => createHash("sha256").update(x1).digest("hex").slice(0, 12);

async function writeVariants(sha12: string, x1: ProcessedImage, x2: ProcessedImage | null, ext: SiteMediaExt = "webp"): Promise<void> {
  const abs1 = issuedPdfAbsolutePath(siteMediaRelativePath(sha12, false, ext));
  await fs.mkdir(path.dirname(abs1), { recursive: true });
  await fs.writeFile(abs1, x1.buffer);
  if (x2) await fs.writeFile(issuedPdfAbsolutePath(siteMediaRelativePath(sha12, true, ext)), x2.buffer);
}

const variantColumns = (x1: ProcessedImage, x2: ProcessedImage | null) => ({
  width: x1.width,
  height: x1.height,
  bytes: x1.buffer.length,
  width2x: x2?.width ?? null,
  height2x: x2?.height ?? null,
  bytes2x: x2?.buffer.length ?? null,
});

/** Nom lisible par défaut : nom du fichier envoyé, sans extension ni chemin. */
const labelFromName = (name: string | null | undefined) => name?.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,5}$/i, "").trim().slice(0, 120) || null;

/**
 * Enregistre une image normalisée : nom = empreinte de la version 1x, donc une image identique n'est pas dupliquée.
 * L'original nettoyé est conservé (recadrage ultérieur) ; une image déjà connue sans original le récupère.
 */
export async function saveSiteImage(input: Buffer, kind: SiteMediaKind, originalName: string | null = null): Promise<SiteMedia> {
  const { x1, x2, type } = await normalizeSiteImage(input, kind);
  const sha12 = mediaSha(x1.buffer);
  const existing = await prisma.siteMedia.findUnique({ where: { sha12 } });
  if (existing?.originalPath) return existing;
  const original = await cleanOriginal(input, type);
  const originalPath = `${ORIGINALS_DIR}/${createHash("sha256").update(original.buffer).digest("hex").slice(0, 16)}.${original.ext}`;
  // Même fichier renvoyé après un recadrage : c'est la même image, sa dernière version sert (pas de doublon).
  const sameOriginal = existing ? null : await prisma.siteMedia.findFirst({ where: { originalPath, kind }, orderBy: { createdAt: "desc" } });
  if (sameOriginal) return sameOriginal;
  const absOriginal = issuedPdfAbsolutePath(originalPath);
  await fs.mkdir(path.dirname(absOriginal), { recursive: true });
  await fs.writeFile(absOriginal, original.buffer);
  const originalColumns = { originalPath, originalBytes: original.buffer.length, originalName: originalName?.slice(0, 255) ?? null };
  if (existing) return prisma.siteMedia.update({ where: { id: existing.id }, data: { ...originalColumns, label: existing.label ?? labelFromName(originalName) } });
  await writeVariants(sha12, x1, x2, siteMediaExt(kind));
  return prisma.siteMedia.upsert({
    where: { sha12 },
    update: {},
    create: { sha12, kind, ...variantColumns(x1, x2), ...originalColumns, label: labelFromName(originalName) },
  });
}

/**
 * Nouvelle version d'une image depuis son original, recadrée autour du point d'intérêt : nouvelle empreinte,
 * donc nouveau nom publié. Renvoie la ligne de cette version (créée, ou déjà connue si le rendu est identique).
 */
export async function renderFromOriginal(media: SiteMedia, focal: Focal): Promise<SiteMedia> {
  if (!media.originalPath) {
    throw new SiteMediaError("Original non conservé (image envoyée avant la médiathèque) : renvoyer l'image pour la recadrer.", "FORMAT");
  }
  if (media.kind === SiteMediaKind.LOGO) throw new SiteMediaError("Un logo n'est pas recadré : il garde ses proportions.", "FORMAT");
  let input: Buffer;
  try {
    input = await fs.readFile(issuedPdfAbsolutePath(media.originalPath));
  } catch {
    throw new SiteMediaError("Original introuvable sur le disque : renvoyer l'image pour la recadrer.", "FORMAT");
  }
  const { x1, x2 } = await normalizeSiteImage(input, media.kind, focal);
  const sha12 = mediaSha(x1.buffer);
  const same = await prisma.siteMedia.findUnique({ where: { sha12 } });
  if (same) return prisma.siteMedia.update({ where: { id: same.id }, data: { focalX: focal.x, focalY: focal.y } });
  await writeVariants(sha12, x1, x2, siteMediaExt(media.kind));
  return prisma.siteMedia.create({
    data: {
      sha12,
      kind: media.kind,
      ...variantColumns(x1, x2),
      label: media.label,
      originalName: media.originalName,
      originalPath: media.originalPath,
      originalBytes: media.originalBytes,
      focalX: focal.x,
      focalY: focal.y,
    },
  });
}

/** Supprime les fichiers d'une image (1x, 2x) et son original s'il n'est plus partagé par une autre version. */
export async function removeSiteMediaFiles(media: SiteMedia): Promise<void> {
  const rm = (rel: string) => fs.rm(issuedPdfAbsolutePath(rel), { force: true });
  const ext = siteMediaExt(media.kind);
  await rm(siteMediaRelativePath(media.sha12, false, ext));
  await rm(siteMediaRelativePath(media.sha12, true, ext));
  if (media.originalPath && !(await prisma.siteMedia.count({ where: { originalPath: media.originalPath, id: { not: media.id } } }))) {
    await rm(media.originalPath);
  }
}

/** Adopte une image déjà publiée (reprise du site) : fichiers du dépôt écrits tels quels, sans original. */
export async function adoptPublishedImage(sha12: string, kind: SiteMediaKind, x1: Buffer, x2: Buffer | null, label: string): Promise<SiteMedia | null> {
  if (mediaSha(x1) !== sha12) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  const size = async (b: Buffer) => {
    const m = await sharp(b).metadata();
    return m.format === "webp" && m.width && m.height ? { buffer: b, width: m.width, height: m.height } : null;
  };
  const v1 = await size(x1).catch(() => null);
  if (!v1) return null;
  const v2 = x2 ? await size(x2).catch(() => null) : null;
  await writeVariants(sha12, v1, v2);
  return prisma.siteMedia.upsert({ where: { sha12 }, update: {}, create: { sha12, kind, ...variantColumns(v1, v2), label: label.slice(0, 120) } });
}

/** Fichier d'une image de l'ERP (aperçu dans l'admin, puis publication). */
export async function readSiteMedia(sha12: string, x2 = false, ext: SiteMediaExt = "webp"): Promise<Buffer | null> {
  if (!/^[a-f0-9]{12}$/.test(sha12)) return null;
  try {
    return await fs.readFile(issuedPdfAbsolutePath(siteMediaRelativePath(sha12, x2, ext)));
  } catch {
    return null;
  }
}
