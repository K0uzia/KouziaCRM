import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SiteMediaKind, type SiteMedia } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";

/**
 * Images de l'espace Site : normalisées en WebP sans métadonnées (EXIF et position GPS retirés), en deux
 * largeurs, sous data/uploads/site/. L'original n'est jamais écrit sur disque.
 * sharp est chargé à la demande : sans son binaire, l'API démarre et seul l'envoi d'image est refusé.
 */

export const SITE_MEDIA_DIR = "site";
export const SITE_MEDIA_MAX_INPUT_BYTES = 15 * 1024 * 1024;

type Variant = { width: number; height?: number; maxBytes: number; position?: "attention" | "top" };
const VARIANTS: Record<SiteMediaKind, { x1: Variant; x2: Variant }> = {
  // Capture 16:9, affichée en 960×540 sur le site.
  CAPTURE: { x1: { width: 960, height: 540, maxBytes: 150_000 }, x2: { width: 1920, height: 1080, maxBytes: 300_000 } },
  // Capture de téléphone 9:19,5, recadrée par le haut : le haut de page reste, le bas d'une page plus longue est coupé.
  MOBILE: {
    x1: { width: 390, height: 844, maxBytes: 150_000, position: "top" },
    x2: { width: 780, height: 1688, maxBytes: 150_000, position: "top" },
  },
  LOGO: { x1: { width: 200, maxBytes: 30_000 }, x2: { width: 400, maxBytes: 60_000 } },
};
const QUALITIES = [80, 72, 64, 56, 48];
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "avif", "heif"]);

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

export const siteMediaRelativePath = (sha12: string, x2 = false) => `${SITE_MEDIA_DIR}/${sha12}${x2 ? "-2x" : ""}.webp`;
export const siteMediaPublicPath = (sha12: string) => `/media/${sha12}.webp`;

export type ProcessedImage = { buffer: Buffer; width: number; height: number };

/** Normalise une image envoyée : version 1x obligatoire, 2x seulement si la source est assez grande. */
export async function normalizeSiteImage(
  input: Buffer,
  kind: SiteMediaKind,
): Promise<{ x1: ProcessedImage; x2: ProcessedImage | null }> {
  const sharp = await loadSharp();
  if (!sharp) throw new SiteMediaError("Traitement d'image indisponible sur ce serveur (sharp manquant).", "UNAVAILABLE");
  const base = () => sharp(input, { limitInputPixels: 50_000_000, failOn: "error" });
  let meta: Awaited<ReturnType<ReturnType<typeof base>["metadata"]>>;
  try {
    meta = await base().metadata();
  } catch {
    throw new SiteMediaError("Fichier illisible : envoyer une image JPEG, PNG, WebP ou AVIF.", "FORMAT");
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw new SiteMediaError("Formats acceptés : JPEG, PNG, WebP, AVIF.", "FORMAT");
  }
  // Dimensions affichées, une fois l'orientation EXIF appliquée.
  const rotated = (meta.orientation ?? 1) >= 5;
  const srcWidth = (rotated ? meta.height : meta.width) ?? 0;
  const srcHeight = (rotated ? meta.width : meta.height) ?? 0;
  const { x1, x2 } = VARIANTS[kind];
  if (srcWidth < x1.width || (x1.height && srcHeight < x1.height)) {
    throw new SiteMediaError(
      `Image trop petite : ${x1.width}${x1.height ? `×${x1.height}` : ""} px au moins (reçu ${srcWidth}×${srcHeight}).`,
      "TOO_SMALL",
    );
  }
  const render = async (v: Variant): Promise<ProcessedImage> => {
    for (const quality of QUALITIES) {
      // Sans withMetadata : sharp n'écrit aucune métadonnée (EXIF, GPS, ICC personnalisé).
      const { data, info } = await base()
        .rotate()
        .resize(
          v.height
            ? { width: v.width, height: v.height, fit: "cover", position: v.position ?? "attention" }
            : { width: v.width, fit: "inside", withoutEnlargement: true },
        )
        .webp({ quality, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= v.maxBytes) return { buffer: data, width: info.width, height: info.height };
    }
    throw new SiteMediaError(
      `Image trop lourde même compressée (plus de ${Math.round(v.maxBytes / 1000)} Ko) : choisir une image plus simple.`,
      "TOO_HEAVY",
    );
  };
  const first = await render(x1);
  const bigEnough = srcWidth >= x2.width && (!x2.height || srcHeight >= x2.height);
  return { x1: first, x2: bigEnough ? await render(x2) : null };
}

/** Enregistre une image normalisée : nom = empreinte de la version 1x, donc une image identique n'est pas dupliquée. */
export async function saveSiteImage(input: Buffer, kind: SiteMediaKind): Promise<SiteMedia> {
  const { x1, x2 } = await normalizeSiteImage(input, kind);
  const sha12 = createHash("sha256").update(x1.buffer).digest("hex").slice(0, 12);
  const existing = await prisma.siteMedia.findUnique({ where: { sha12 } });
  if (existing) return existing;
  const abs1 = issuedPdfAbsolutePath(siteMediaRelativePath(sha12));
  await fs.mkdir(path.dirname(abs1), { recursive: true });
  await fs.writeFile(abs1, x1.buffer);
  if (x2) await fs.writeFile(issuedPdfAbsolutePath(siteMediaRelativePath(sha12, true)), x2.buffer);
  return prisma.siteMedia.upsert({
    where: { sha12 },
    update: {},
    create: {
      sha12,
      kind,
      width: x1.width,
      height: x1.height,
      bytes: x1.buffer.length,
      width2x: x2?.width ?? null,
      height2x: x2?.height ?? null,
      bytes2x: x2?.buffer.length ?? null,
    },
  });
}

/** Fichier d'une image de l'ERP (aperçu dans l'admin, puis publication). */
export async function readSiteMedia(sha12: string, x2 = false): Promise<Buffer | null> {
  if (!/^[a-f0-9]{12}$/.test(sha12)) return null;
  try {
    return await fs.readFile(issuedPdfAbsolutePath(siteMediaRelativePath(sha12, x2)));
  } catch {
    return null;
  }
}
