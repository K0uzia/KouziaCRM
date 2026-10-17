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

export async function loadBrandLogoDataUrl(
  brandLogoPath: string | null | undefined,
): Promise<string | null> {
  const logo = await readBrandLogo(brandLogoPath);
  if (!logo) return null;
  let { buffer, mime } = logo;
  // @react-pdf ne lit que le PNG et le JPEG : un ancien logo WebP ou GIF est converti à la volée.
  if (mime !== "image/png" && mime !== "image/jpeg") {
    const { loadSharp } = await import("@/lib/site/media.js");
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
      buffer = await sharp(buffer).png().toBuffer();
      mime = "image/png";
    } catch {
      return null;
    }
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
