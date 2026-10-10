import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/prisma.js";

// Une base en retard sur le client Prisma généré fait échouer chaque requête sur la table modifiée
// (cas réel en dev : 500 sur tout le portail). Vérifié au démarrage, exposé dans /api/health.

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../prisma/migrations");

/** Dossiers de migration versionnés (ceux qui contiennent un migration.sql). */
export function listMigrationNames(dir = MIGRATIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "migration.sql")))
    .map((e) => e.name)
    .sort();
}

/** Migrations du dépôt pas encore appliquées avec succès à la base. */
export function diffPending(available: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return available.filter((name) => !done.has(name));
}

let pending: string[] = [];

export async function checkPendingMigrations(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  pending = diffPending(
    listMigrationNames(),
    rows.map((r) => r.migration_name),
  );
  return pending;
}

/** Résultat du dernier contrôle (au démarrage), pour /api/health. */
export function pendingMigrationCount(): number {
  return pending.length;
}
