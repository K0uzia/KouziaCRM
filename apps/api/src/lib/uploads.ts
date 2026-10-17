import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dossier data/uploads unique pour l'API et le worker : racine du dépôt (KOUZIA_APP_DIR en prod,
 * /app sous Docker) et non process.cwd(). En dev, l'API tourne dans apps/api et le worker à la
 * racine ; les deux doivent lire les mêmes fichiers (PDF archivés, logo de la charte).
 */
export const UPLOADS_DIR =
  process.env.KOUZIA_UPLOADS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../data/uploads");

/** Chemin absolu d'un fichier rangé sous data/uploads (chemin relatif en / ou en \). */
export function uploadsPath(relative: string): string {
  return path.resolve(UPLOADS_DIR, relative.replace(/\\/g, "/"));
}
