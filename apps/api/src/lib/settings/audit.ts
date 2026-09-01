import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import type { SettingsTabId } from "@/lib/settings/public.js";
import { isSecretColumn } from "@/lib/settings/secrets.js";

export type AuditActor = {
  userId?: string | null;
  userEmail?: string | null;
};

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function diffChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (key === "updatedAt" || key === "createdAt" || key === "id") continue;
    if (isSecretColumn(key)) continue;
    if (!jsonEqual(before[key], after[key])) changed.push(key);
  }
  return changed;
}

export async function logSettingsAudit(opts: {
  actor?: AuditActor | null;
  tab: SettingsTabId;
  fields: string[];
}): Promise<void> {
  const unique = [...new Set(opts.fields.filter(Boolean))];
  if (unique.length === 0) return;
  const data: Prisma.SettingsAuditLogCreateManyInput[] = unique.map((field) => ({
    userId: opts.actor?.userId ?? null,
    userEmail: opts.actor?.userEmail ?? null,
    tab: opts.tab,
    field,
  }));
  await prisma.settingsAuditLog.createMany({ data });
}
