#!/usr/bin/env bash
# Backup SQLite KouziaCRM : à lancer via cron de l'hôte Proxmox.
#
# Cron recommandé (crontab -e sur l'hôte) :
#   0 2 * * * /opt/kouziacrm/scripts/backup.sh
#
# Prérequis :
#   - sqlite3 installé sur l'hôte (apt install sqlite3)
#   - gpg installé (apt install gnupg)
#   - Une passphrase dans /etc/kouzia-backup-pass (chmod 600, root only)
#     echo "passphrase forte" | sudo tee /etc/kouzia-backup-pass >/dev/null
#     sudo chmod 600 /etc/kouzia-backup-pass
#
# Restore (test mensuel conseillé) :
#   gpg -d /backup/kouzia/kouziacrm-2026-08-27.db.gpg | sqlite3 data/kouziacrm.db.restore
#   mv data/kouziacrm.db data/kouziacrm.db.broken
#   mv data/kouziacrm.db.restore data/kouziacrm.db
#   docker compose restart app worker

set -euo pipefail

# --- Configuration (override via env si besoin) ---
DB_PATH="${KOUZIA_DB_PATH:-/opt/kouziacrm/data/kouziacrm.db}"
BACKUP_DIR="${KOUZIA_BACKUP_DIR:-/backup/kouzia}"
RETENTION_DAYS="${KOUZIA_RETENTION_DAYS:-30}"
PASSPHRASE_FILE="${KOUZIA_PASSPHRASE_FILE:-/etc/kouzia-backup-pass}"
LOG_FILE="${KOUZIA_LOG_FILE:-/var/log/kouzia-backup.log}"
STAMP="$(date +%F)"
TMP_DB="$(mktemp)"
ENC_FILE="${BACKUP_DIR}/kouziacrm-${STAMP}.db.gpg"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE" >&2
}

trap 'rm -f "$TMP_DB"' EXIT

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  log "ERREUR: base SQLite introuvable: $DB_PATH"
  exit 1
fi

if [[ ! -f "$PASSPHRASE_FILE" ]]; then
  log "ERREUR: passphrase file introuvable: $PASSPHRASE_FILE (voir scripts/backup.sh)"
  exit 1
fi

# Backup online cohérent via l'API SQLite (.backup gère le WAL correctement,
# contrairement à un cp brut qui peut produire un fichier incohérent).
log "Backup SQLite: $DB_PATH -> $TMP_DB"
if ! sqlite3 "$DB_PATH" ".backup '$TMP_DB'"; then
  log "ERREUR: sqlite3 .backup a échoué"
  exit 1
fi

# Vérification d'intégrité du backup avant chiffrement.
INTEGRITY="$(sqlite3 "$TMP_DB" "PRAGMA integrity_check;")"
if [[ "$INTEGRITY" != "ok" ]]; then
  log "ERREUR: integrity_check != ok: $INTEGRITY"
  exit 1
fi
log "Intégrité OK"

# Chiffrement symétrique (passphrase hors du repo).
log "Chiffrement GPG -> $ENC_FILE"
gpg --batch --yes --symmetric \
  --cipher-algo AES256 \
  --passphrase-file "$PASSPHRASE_FILE" \
  --output "$ENC_FILE" \
  "$TMP_DB"

# Rotation : supprime les backups de plus de RETENTION_DAYS jours.
log "Rotation: suppression des backups > ${RETENTION_DAYS}j dans $BACKUP_DIR"
find "$BACKUP_DIR" -name 'kouziacrm-*.db.gpg' -mtime "+${RETENTION_DAYS}" -delete

# Résumé.
SIZE="$(stat -c %s "$ENC_FILE" 2>/dev/null || stat -f %z "$ENC_FILE")"
COUNT="$(find "$BACKUP_DIR" -name 'kouziacrm-*.db.gpg' | wc -l | tr -d ' ')"
log "OK: $ENC_FILE ($(( SIZE / 1024 )) Ko) : $COUNT backup(s) conservé(s)"
