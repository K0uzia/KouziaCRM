#!/usr/bin/env bash
# Backup SQLite cohérent (API .backup), intégrité, chiffrement GPG, rotation,
# et synchronisation rsync optionnelle vers un hôte distant.
#
# .backup passe par l'API de sauvegarde de SQLite : copie cohérente même app lancée (cron de nuit), à
# la différence d'un cp du fichier pendant une écriture (sqlite.org/howtocorrupt.html). kouziactl update
# arrête quand même l'app avant : rien n'est écrit entre la copie et la migration.
# La base et data/uploads sont lus par le compte du service (run_as_app_argv) : root ne fait que chiffrer
# le flux et écrire dans ses propres dossiers.
#
# Config rsync : /etc/kouzia/rsync.env (voir conf/rsync.env.example)
# Sortie standard : chemin du .db.gpg créé (rien d'autre). Messages : écran et backup.log.
#
# Cron Alpine : /etc/periodic/daily/kouzia-backup (posé par install.sh et update.sh)
# Ou : 0 2 * * * /bin/bash /opt/kouziacrm/scripts/alpine/backup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ORIG_ARGS=("$@")
TAG=""
SKIP_RSYNC=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --skip-rsync) SKIP_RSYNC=1; shift ;;
    -h|--help)
      echo "Usage: backup.sh [--tag LABEL] [--skip-rsync]"
      exit 0
      ;;
    *) die "Option inconnue: $1" ;;
  esac
done
[[ -z "$TAG" || "$TAG" =~ ^[a-z0-9-]+$ ]] || die "Étiquette invalide (minuscules, chiffres, tirets) : $TAG"

require_root
# Cron pendant une mise à jour ou une restauration : attente jusqu'à 30 min, puis échec journalisé.
ops_lock 1800 "${SCRIPT_DIR}/backup.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
umask 077
trap 'exit 130' INT TERM

ensure_ops_dirs
LOG_FILE="${KOUZIA_OPS_LOG_DIR}/backup.log"

blog() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" | tee -a "$LOG_FILE" >&2
}

require_cmd sqlite3 gpg tar
[[ -f "$KOUZIA_DB_PATH" ]] || die "Base SQLite introuvable: $KOUZIA_DB_PATH"
[[ -f "$KOUZIA_PASSPHRASE_FILE" ]] || die "Passphrase absente: $KOUZIA_PASSPHRASE_FILE"

STAMP="$(date +%F)"
SUFFIX=""
[[ -n "$TAG" ]] && SUFFIX="-${TAG}"
# Évite d'écraser le backup du jour si plusieurs runs (pre-update + cron)
if [[ -n "$TAG" ]] || [[ -f "${KOUZIA_BACKUP_DIR}/kouziacrm-${STAMP}.db.gpg" ]]; then
  STAMP="$(date +%F_%H%M%S)"
fi
ENC_FILE="${KOUZIA_BACKUP_DIR}/kouziacrm-${STAMP}${SUFFIX}.db.gpg"
# Copie de travail : dossier temporaire donné au compte du service, qui y écrit la copie de la base.
WORK="$(mktemp -d)"
chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "$WORK"
META_DIR=""
cleanup() {
  rm -rf "$WORK"
  [[ -z "$META_DIR" ]] || rm -rf "$META_DIR"
}
trap cleanup EXIT

disk_guard "$KOUZIA_BACKUP_DIR" 200

gpg_encrypt_to() {
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$KOUZIA_PASSPHRASE_FILE" \
    --output "$1"
}

blog "Backup SQLite: $KOUZIA_DB_PATH -> tmp"
# .timeout : attend jusqu'à 15 s un verrou d'écriture de l'app au lieu d'échouer aussitôt (SQLITE_BUSY).
if ! run_as_app_argv sqlite3 -cmd ".timeout 15000" "$KOUZIA_DB_PATH" ".backup '${WORK}/db'"; then
  blog "ERREUR: sqlite3 .backup a échoué"
  exit 1
fi

INTEGRITY="$(run_as_app_argv sqlite3 "${WORK}/db" "PRAGMA integrity_check;" 2>&1 || true)"
if [[ "$INTEGRITY" != "ok" ]]; then
  blog "ERREUR: integrity_check != ok: $INTEGRITY"
  exit 1
fi
blog "Intégrité OK"

# Meta chiffrée : .env + liste des migrations (reprise disaster recovery)
if [[ -f "${KOUZIA_APP_DIR}/.env" ]]; then
  META_DIR="$(mktemp -d)"
  cp "${KOUZIA_APP_DIR}/.env" "${META_DIR}/dotenv"
  run_as_app_argv sqlite3 "${WORK}/db" "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;" \
    > "${META_DIR}/migrations.txt" 2>/dev/null || true
  tar -C "$META_DIR" -czf - . | gpg_encrypt_to "${ENC_FILE%.db.gpg}.meta.tar.gz.gpg"
  blog "Meta (.env + migrations) chiffrée"
fi

blog "Chiffrement GPG -> $ENC_FILE"
run_as_app_argv cat "${WORK}/db" | gpg_encrypt_to "$ENC_FILE"

# Uploads (pièces jointes) : snapshot tar.gz chiffré si non vide
UPLOADS="${KOUZIA_DATA_DIR}/uploads"
if [[ -d "$UPLOADS" && -n "$(find "$UPLOADS" -type f 2>/dev/null | head -n 1)" ]]; then
  run_as_app_argv tar -C "$KOUZIA_DATA_DIR" -czf - uploads | gpg_encrypt_to "${ENC_FILE%.db.gpg}.uploads.tar.gz.gpg"
  blog "Uploads chiffrés"
fi

blog "Rotation > ${KOUZIA_RETENTION_DAYS}j dans $KOUZIA_BACKUP_DIR"
find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.db.gpg' -mtime "+${KOUZIA_RETENTION_DAYS}" -delete
find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.meta.tar.gz.gpg' -mtime "+${KOUZIA_RETENTION_DAYS}" -delete
find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.uploads.tar.gz.gpg' -mtime "+${KOUZIA_RETENTION_DAYS}" -delete

SIZE="$(stat -c %s "$ENC_FILE" 2>/dev/null || stat -f %z "$ENC_FILE")"
COUNT="$(find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.db.gpg' | wc -l | tr -d ' ')"
blog "OK local: $ENC_FILE ($(( SIZE / 1024 )) Ko) : $COUNT backup(s)"
printf '%s\n' "$ENC_FILE"

# --- Rsync offsite ---
load_rsync_conf
if [[ "$SKIP_RSYNC" -eq 1 ]]; then
  blog "Rsync skip (--skip-rsync)"
elif [[ -n "${KOUZIA_RSYNC_TARGET:-}" ]]; then
  require_cmd rsync
  RSYNC_OPTS=(-az --timeout=60)
  if [[ -n "${KOUZIA_RSYNC_SSH:-}" ]]; then
    RSYNC_OPTS+=(-e "$KOUZIA_RSYNC_SSH")
  fi
  if [[ "${KOUZIA_RSYNC_DELETE:-0}" == "1" ]]; then
    RSYNC_OPTS+=(--delete)
  fi
  blog "Rsync -> $KOUZIA_RSYNC_TARGET"
  if rsync "${RSYNC_OPTS[@]}" "${KOUZIA_BACKUP_DIR}/" "$KOUZIA_RSYNC_TARGET" >&2; then
    blog "Rsync OK"
  else
    blog "ERREUR: rsync vers $KOUZIA_RSYNC_TARGET a échoué"
    exit 1
  fi
else
  blog "Pas de KOUZIA_RSYNC_TARGET (voir $KOUZIA_RSYNC_CONF) : backup local uniquement"
fi
