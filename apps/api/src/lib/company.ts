import { prisma } from "@/lib/prisma";
import type { CompanySettings } from "@prisma/client";

let cached: { at: number; value: CompanySettings } | null = null;
const TTL_MS = 30_000;

export async function getCompanySettings(): Promise<CompanySettings> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const settings = await prisma.companySettings.findFirst();
  if (!settings) {
    throw new Error("CompanySettings manquantes  -  lancez npm run db:seed");
  }
  cached = { at: now, value: settings };
  return settings;
}

/** Invalide le cache (après PUT /settings). */
export function invalidateCompanySettingsCache() {
  cached = null;
}
