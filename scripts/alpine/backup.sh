#!/usr/bin/env bash
# Backup SQLite cohérent (API .backup), intégrité, chiffrement GPG, rotation,
# et synchronisation rsync optionnelle vers un hôte distant.
#
# Config rsync : /etc/kouzia/rsync.env (voir conf/rsync.env.example)
#
# Cron Alpine : /etc/periodic/daily/kouzia-backup (posé par install.sh)
# Ou : 0 2 * * * /opt/kouziacrm/scripts/alpine/backup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

TAG=""
SKIP_RSYNC=0
LOG_FILE="${KOUZIA_LOG_DIR}/backup.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --skip-rsync) SKIP_RSYNC=1; shift ;;
    -h|--help)
      echo "Usage: backup.sh [--tag LABEL] [--skip-rsync]"
      exit 0
      ;;
    *) die "Option inconnue: $1" ;;
  esac
done

mkdir -p "$KOUZIA_LOG_DIR" "$KOUZIA_BACKUP_DIR"

blog() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" | tee -a "$LOG_FILE" >&2
}

require_cmd sqlite3 gpg
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
TMP_DB="$(mktemp)"
ENV_BUNDLE=""
BUNDLE_DIR=""
cleanup() {
  rm -f "$TMP_DB" ${ENV_BUNDLE:+"$ENV_BUNDLE"}
  [[ -n "$BUNDLE_DIR" ]] && rm -rf "$BUNDLE_DIR"
}
trap cleanup EXIT

disk_guard "$KOUZIA_BACKUP_DIR" 200

blog "Backup SQLite: $KOUZIA_DB_PATH -> tmp"
if ! sqlite3 "$KOUZIA_DB_PATH" ".backup '$TMP_DB'"; then
  blog "ERREUR: sqlite3 .backup a échoué"
  exit 1
fi

INTEGRITY="$(sqlite3 "$TMP_DB" "PRAGMA integrity_check;")"
if [[ "$INTEGRITY" != "ok" ]]; then
  blog "ERREUR: integrity_check != ok: $INTEGRITY"
  exit 1
fi
blog "Intégrité OK"

# Meta chiffrée : .env + liste des migrations (reprise disaster recovery)
if [[ -f "${KOUZIA_APP_DIR}/.env" ]]; then
  ENV_BUNDLE="$(mktemp)"
  BUNDLE_DIR="$(mktemp -d)"
  cp "${KOUZIA_APP_DIR}/.env" "${BUNDLE_DIR}/dotenv"
  sqlite3 "$TMP_DB" "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at;" \
    > "${BUNDLE_DIR}/migrations.txt" 2>/dev/null || true
  tar -C "$BUNDLE_DIR" -czf "$ENV_BUNDLE" .
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$KOUZIA_PASSPHRASE_FILE" \
    --output "${ENC_FILE%.db.gpg}.meta.tar.gz.gpg" \
    "$ENV_BUNDLE"
  blog "Meta (.env + migrations) chiffrée"
fi

blog "Chiffrement GPG -> $ENC_FILE"
gpg --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase-file "$KOUZIA_PASSPHRASE_FILE" \
  --output "$ENC_FILE" \
  "$TMP_DB"

# Uploads (pièces jointes) : snapshot tar.gz chiffré si non vide
UPLOADS="${KOUZIA_DATA_DIR}/uploads"
if [[ -d "$UPLOADS" ]] && find "$UPLOADS" -type f 2>/dev/null | grep -q .; then
  UP_TMP="$(mktemp)"
  tar -C "$KOUZIA_DATA_DIR" -czf "$UP_TMP" uploads
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$KOUZIA_PASSPHRASE_FILE" \
    --output "${ENC_FILE%.db.gpg}.uploads.tar.gz.gpg" \
    "$UP_TMP"
  rm -f "$UP_TMP"
  blog "Uploads chiffrés"
fi

blog "Rotation > ${KOUZIA_RETENTION_DAYS}j dans $KOUZIA_BACKUP_DIR"
find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.db.gpg' -mtime "+${KOUZIA_RETENTION_DAYS}" -delete
find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.meta.tar.gz.gpg' -mtime "+${KOUZIA_RETENTION_DAYS}" -delete
find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.uploads.tar.gz.gpg' -mtime "+${KOUZIA_RETENTION_DAYS}" -delete

SIZE="$(stat -c %s "$ENC_FILE" 2>/dev/null || stat -f %z "$ENC_FILE")"
COUNT="$(find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.db.gpg' | wc -l | tr -d ' ')"
blog "OK local: $ENC_FILE ($(( SIZE / 1024 )) Ko) : $COUNT backup(s)"

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
  if rsync "${RSYNC_OPTS[@]}" "${KOUZIA_BACKUP_DIR}/" "$KOUZIA_RSYNC_TARGET"; then
    blog "Rsync OK"
  else
    blog "ERREUR: rsync vers $KOUZIA_RSYNC_TARGET a échoué"
    exit 1
  fi
else
  blog "Pas de KOUZIA_RSYNC_TARGET (voir $KOUZIA_RSYNC_CONF) : backup local uniquement"
fi
