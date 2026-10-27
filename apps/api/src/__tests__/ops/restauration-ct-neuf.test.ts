import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { openArchive, sealArchive } from "@/lib/pdf/archive-file.js";

// Demande du 27/10/2026 : restauration complète sur un CT neuf. L'installation génère une NOUVELLE ENCRYPTION_KEY ;
// sans la clé de la sauvegarde, base et pièces jointes restaurées seraient illisibles. kouziactl restore --meta remet la
// clé de l'archive meta (jamais affichée). Test : sauvegarde de l'ancien CT (clé A), CT neuf (clé B), restauration
// refusée sans --meta, puis --meta, puis données relisibles. Mêmes fonctions que scripts/alpine/restore.sh, dans le même
// ordre ; seules les opérations de service (arrêt, migrations, démarrage, santé) sont neutralisées.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const BASH = process.platform === "win32" && fs.existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const posix = (p: string) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);

function tools(): boolean {
  return spawnSync(BASH, ["-c", "command -v gpg && command -v sqlite3 && command -v tar && command -v node"], { encoding: "utf8" }).status === 0;
}

describe.skipIf(!tools())("restauration sur un CT neuf (kouziactl restore --meta)", () => {
  it("nouvelle clé générée, restauration refusée sans --meta, puis clé reprise : base et pièces jointes relisibles", () => {
    const keyA = process.env.ENCRYPTION_KEY!;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kouzia-restore-"));
    const dirs = Object.fromEntries(["ops", "app", "app/data", "app/data/uploads/issued-documents", "etc", "backup", "state", "logs", "gnupg", "meta", "check"].map((d) => [d, path.join(tmp, d)]));
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    // Scripts tels que sur le CT (fins de ligne Unix).
    fs.writeFileSync(path.join(dirs.ops!, "lib.sh"), fs.readFileSync(path.join(ROOT, "scripts/alpine/lib.sh"), "utf8").replace(/\r\n/g, "\n"));
    fs.copyFileSync(path.join(ROOT, "scripts/alpine/check-key.mjs"), path.join(dirs.ops!, "check-key.mjs"));

    // Ancien CT : clé A, une fiche client chiffrée, un PDF archivé chiffré.
    const EMAIL = "lea.restauration@exemple.fr";
    const PDF = Buffer.from("%PDF-1.7 facture de test\n");
    fs.writeFileSync(path.join(dirs.app!, ".env"), `NODE_ENV="production"\nENCRYPTION_KEY="${keyA}"\n`);
    fs.writeFileSync(path.join(dirs["app/data/uploads/issued-documents"]!, "F-2026-0001.pdf"), sealArchive(PDF));
    fs.writeFileSync(path.join(dirs.etc!, "backup-pass"), randomBytes(24).toString("base64"));
    const seed = path.join(tmp, "ancienne.db");
    const sql = `CREATE TABLE Client (id TEXT, emailEncrypted TEXT, phoneEncrypted TEXT, notepadEncrypted TEXT); CREATE TABLE Invoice (id TEXT, clientSnapshotEncrypted TEXT); CREATE TABLE _prisma_migrations (migration_name TEXT, finished_at TEXT); INSERT INTO Client VALUES ('c1', '${encrypt(EMAIL)}', NULL, NULL);`;
    expect(spawnSync("sqlite3", [seed, sql], { encoding: "utf8" }).status).toBe(0);

    const env = {
      ...process.env,
      GNUPGHOME: posix(dirs.gnupg!),
      KOUZIA_APP_DIR: posix(dirs.app!),
      KOUZIA_DATA_DIR: posix(dirs["app/data"]!),
      KOUZIA_DB_PATH: posix(path.join(dirs["app/data"]!, "kouziacrm.db")),
      KOUZIA_ETC_DIR: posix(dirs.etc!),
      KOUZIA_PASSPHRASE_FILE: posix(path.join(dirs.etc!, "backup-pass")),
      KOUZIA_BACKUP_DIR: posix(dirs.backup!),
      KOUZIA_STATE_DIR: posix(dirs.state!),
      KOUZIA_OPS_LOG_DIR: posix(dirs.logs!),
      KOUZIA_LOG_DIR: posix(dirs.logs!),
      T: posix(tmp),
    };
    const script = `
      set -euo pipefail
      source "$T/ops/lib.sh"
      env_fix_perms() { :; }; stop_app_stack() { :; }; assert_app_stopped() { :; }; prisma_migrate_deploy() { :; }
      service_safe() { :; }; wait_health() { return 0; }
      chmod 700 "$GNUPGHOME"
      enc() { gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$KOUZIA_PASSPHRASE_FILE" --output "$1"; }
      # Sauvegarde de l'ancien CT, comme backup.sh : base, pièces jointes, meta (.env).
      enc "$KOUZIA_BACKUP_DIR/k.db.gpg" < "$T/ancienne.db"
      tar -C "$KOUZIA_DATA_DIR" -czf - uploads | enc "$KOUZIA_BACKUP_DIR/k.uploads.tar.gz.gpg"
      cp "$KOUZIA_APP_DIR/.env" "$T/meta/dotenv"
      tar -C "$T/meta" -czf - . | enc "$KOUZIA_BACKUP_DIR/k.meta.tar.gz.gpg"
      # CT neuf : données absentes, nouvelle clé générée par l'installation.
      rm -rf "$KOUZIA_DATA_DIR/uploads"
      printf 'NODE_ENV="production"\\nENCRYPTION_KEY="%s"\\n' "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')" > "$KOUZIA_APP_DIR/.env"
      # restore.sh : contrôle de la base, puis plan pour la clé.
      decrypt_to_app "$KOUZIA_BACKUP_DIR/k.db.gpg" "$T/check/db"
      check_db_as_app "$T/check/db"
      echo "SANS_META=$(restore_key_plan "$T/check/db" "")"
      PLAN="$(restore_key_plan "$T/check/db" "$KOUZIA_BACKUP_DIR/k.meta.tar.gz.gpg")"
      echo "AVEC_META=$PLAN"
      [[ "$PLAN" == "meta" ]] && restore_key_from_meta "$KOUZIA_BACKUP_DIR/k.meta.tar.gz.gpg"
      restore_backup "$KOUZIA_BACKUP_DIR/k.db.gpg" "$KOUZIA_BACKUP_DIR/k.uploads.tar.gz.gpg"
      echo "APRES=$(restore_key_plan "$KOUZIA_DB_PATH" "")"
    `;
    const run = spawnSync(BASH, ["-c", script], { env, encoding: "utf8", timeout: 120_000 });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status, out).toBe(0);
    // Sans --meta : refus (la clé neuve ne lit pas la sauvegarde) ; avec : clé de la sauvegarde ; après : compatible.
    expect(out).toContain("SANS_META=missing-meta");
    expect(out).toContain("AVEC_META=meta");
    expect(out).toContain("APRES=current");
    // La clé n'est jamais affichée.
    expect(out).not.toContain(keyA);

    // Données relisibles avec la clé du .env restauré.
    const restoredKey = /ENCRYPTION_KEY="([0-9a-f]{64})"/.exec(fs.readFileSync(path.join(dirs.app!, ".env"), "utf8"))![1]!;
    expect(restoredKey).toBe(keyA);
    const stored = spawnSync("sqlite3", [path.join(dirs["app/data"]!, "kouziacrm.db"), "SELECT emailEncrypted FROM Client;"], { encoding: "utf8" }).stdout.trim();
    expect(decrypt(stored)).toBe(EMAIL);
    expect(openArchive(fs.readFileSync(path.join(dirs["app/data"]!, "uploads/issued-documents/F-2026-0001.pdf"))).equals(PDF)).toBe(true);
    // Ancien .env (clé neuve) gardé à côté.
    expect(fs.readdirSync(dirs.app!).some((f) => f.startsWith(".env.avant-restauration-"))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 150_000);
});
