#!/usr/bin/env bash
# Restauration d'un backup GPG KouziaCRM.
#
# Usage :
#   kouziactl restore /var/backup/kouzia/kouziacrm-2026-09-03.db.gpg
#   kouziactl restore --uploads /var/backup/kouzia/kouziacrm-….uploads.tar.gz.gpg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

RESTORE_UPLOADS=""
BACKUP_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uploads) RESTORE_UPLOADS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: restore.sh <fichier.db.gpg> [--uploads fichier.uploads.tar.gz.gpg]"
      exit 0
      ;;
    *)
      if [[ -z "$BACKUP_FILE" ]]; then
        BACKUP_FILE="$1"
        shift
      else
        die "Argument inattendu: $1"
      fi
      ;;
  esac
done

[[ -n "$BACKUP_FILE" ]] || die "Fichier backup requis. Exemple: kouziactl restore /var/backup/kouzia/kouziacrm-DATE.db.gpg"
[[ -f "$BACKUP_FILE" ]] || die "Fichier introuvable: $BACKUP_FILE"
[[ -f "$KOUZIA_PASSPHRASE_FILE" ]] || die "Passphrase absente: $KOUZIA_PASSPHRASE_FILE"
require_root
require_cmd gpg sqlite3

log "Arrêt des services…"
service_safe kouziacrm-worker stop
service_safe kouziacrm stop

TMP_DB="$(mktemp)"
trap 'rm -f "$TMP_DB"' EXIT

log "Déchiffrement…"
gpg --batch --yes --decrypt \
  --passphrase-file "$KOUZIA_PASSPHRASE_FILE" \
  --output "$TMP_DB" \
  "$BACKUP_FILE"

INTEGRITY="$(sqlite3 "$TMP_DB" "PRAGMA integrity_check;")"
[[ "$INTEGRITY" == "ok" ]] || die "integrity_check échoué: $INTEGRITY"
ok "Intégrité OK"

mkdir -p "$KOUZIA_DATA_DIR"
if [[ -f "$KOUZIA_DB_PATH" ]]; then
  BROKEN="${KOUZIA_DB_PATH}.broken-$(date +%Y%m%d%H%M%S)"
  log "Conservation de l'ancienne DB → $BROKEN"
  mv "$KOUZIA_DB_PATH" "$BROKEN"
  # Nettoyage WAL/SHM orphelins
  rm -f "${KOUZIA_DB_PATH}-wal" "${KOUZIA_DB_PATH}-shm"
fi

cp "$TMP_DB" "$KOUZIA_DB_PATH"
chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "$KOUZIA_DB_PATH"
chmod 640 "$KOUZIA_DB_PATH"
ok "DB restaurée: $KOUZIA_DB_PATH"

if [[ -n "$RESTORE_UPLOADS" ]]; then
  [[ -f "$RESTORE_UPLOADS" ]] || die "Uploads introuvables: $RESTORE_UPLOADS"
  UP_TMP="$(mktemp)"
  gpg --batch --yes --decrypt \
    --passphrase-file "$KOUZIA_PASSPHRASE_FILE" \
    --output "$UP_TMP" \
    "$RESTORE_UPLOADS"
  tar -C "$KOUZIA_DATA_DIR" -xzf "$UP_TMP"
  rm -f "$UP_TMP"
  chown -R "${KOUZIA_USER}:${KOUZIA_GROUP}" "${KOUZIA_DATA_DIR}/uploads"
  ok "Uploads restaurés"
fi

log "Redémarrage…"
service_safe kouziacrm start
service_safe kouziacrm-worker start
wait_health || warn "API unhealthy après restore : kouziactl logs app"

ok "Restore terminé."
