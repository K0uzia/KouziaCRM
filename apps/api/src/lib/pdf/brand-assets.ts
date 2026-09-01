import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CompanySettings } from "@prisma/client";

function mimeFromLogoPath(logoPath: string): string {
  const ext = path.extname(logoPath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

export async function loadBrandLogoDataUrl(
  brandLogoPath: string | null | undefined,
): Promise<string | null> {
  if (!brandLogoPath) return null;
  const abs = path.resolve(process.cwd(), "data", "uploads", brandLogoPath);
  try {
    const buf = await readFile(abs);
    return `data:${mimeFromLogoPath(brandLogoPath)};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
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
