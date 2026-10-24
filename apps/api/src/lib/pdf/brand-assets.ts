import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CompanySettings } from "@prisma/client";
import { uploadsPath } from "@/lib/uploads.js";

function mimeFromLogoPath(logoPath: string): string {
  const ext = path.extname(logoPath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

/**
 * Fichiers candidats du logo : dossier data/uploads partagé (API et worker), puis l'ancien
 * emplacement relatif au dossier de lancement, où le logo était rangé avant (lecture seule).
 */
export function brandLogoCandidates(brandLogoPath: string): string[] {
  const rel = brandLogoPath.replace(/\\/g, "/");
  return [...new Set([uploadsPath(rel), path.resolve(process.cwd(), "data", "uploads", rel)])];
}

/** Contenu du logo enregistré, ou null si le fichier manque. */
export async function readBrandLogo(
  brandLogoPath: string | null | undefined,
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (!brandLogoPath) return null;
  for (const abs of brandLogoCandidates(brandLogoPath)) {
    try {
      return { buffer: await readFile(abs), mime: mimeFromLogoPath(brandLogoPath) };
    } catch {
      /* emplacement suivant */
    }
  }
  return null;
}

/** Plus grand côté du logo dans les PDF (4 fois sa taille affichée de 64 pt). */
export const LOGO_MAX_PX = 256;

export async function loadBrandLogoDataUrl(
  brandLogoPath: string | null | undefined,
): Promise<string | null> {
  const logo = await readBrandLogo(brandLogoPath);
  if (!logo) return null;
  let { buffer, mime } = logo;
  const { loadSharp } = await import("@/lib/site/media.js");
  const sharp = await loadSharp();
  // @react-pdf ne lit que le PNG et le JPEG : sans sharp, un logo WebP ou GIF est ignoré, les autres gardés tels quels.
  if (!sharp) return mime === "image/png" || mime === "image/jpeg" ? `data:${mime};base64,${buffer.toString("base64")}` : null;
  try {
    // Affiché à 64 pt : 256 px au plus suffisent à l'impression, sans alourdir chaque PDF (jamais agrandi). PNG pour garder
    // la transparence (WebP et GIF compris), JPEG reste JPEG. Seuls les documents rendus ensuite changent, pas les archives.
    const resized = sharp(buffer).resize({ width: LOGO_MAX_PX, height: LOGO_MAX_PX, fit: "inside", withoutEnlargement: true });
    buffer = mime === "image/jpeg" ? await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer() : await resized.png({ compressionLevel: 9 }).toBuffer();
    if (mime !== "image/jpeg") mime = "image/png";
  } catch {
    if (mime !== "image/png" && mime !== "image/jpeg") return null;
  }
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

export type PdfCompanySettings = CompanySettings & {
  brandLogoDataUrl?: string | null;
};

export async function enrichCompanyForPdf(
  company: CompanySettings,
): Promise<PdfCompanySettings> {
  const brandLogoDataUrl = await loadBrandLogoDataUrl(company.brandLogoPath);
  return { ...company, brandLogoDataUrl };
}
