#!/usr/bin/env bash
# État rapide du CT : services, santé API, disque, backups, migrations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

echo "${C_BOLD}KouziaCRM status${C_RESET}"
echo "  Host     : $(hostname) (Alpine $(cat /etc/alpine-release 2>/dev/null || echo '?'))"
echo "  App      : $KOUZIA_APP_DIR"
echo "  Node     : $(node -v 2>/dev/null || echo absent)"
echo ""

echo "${C_BOLD}Services${C_RESET}"
for svc in kouziacrm kouziacrm-worker crond; do
  if service_exists "$svc"; then
    st="$(rc-service "$svc" status 2>&1 | head -1 || true)"
    echo "  $svc : $st"
  else
    echo "  $svc : (non installé)"
  fi
done
echo ""

echo "${C_BOLD}Health${C_RESET}"
if curl -fsS "$KOUZIA_HEALTH_URL" >/dev/null 2>&1; then
  ok "API $KOUZIA_HEALTH_URL"
else
  warn "API ne répond pas ($KOUZIA_HEALTH_URL)"
fi
echo ""

echo "${C_BOLD}Disque${C_RESET}"
df -h "$KOUZIA_APP_DIR" "$KOUZIA_BACKUP_DIR" 2>/dev/null | awk 'NR==1 || /^\/|^Filesystem/'
echo ""

echo "${C_BOLD}Base SQLite${C_RESET}"
if [[ -f "$KOUZIA_DB_PATH" ]]; then
  SIZE="$(du -h "$KOUZIA_DB_PATH" | awk '{print $1}')"
  echo "  Path : $KOUZIA_DB_PATH ($SIZE)"
  if command -v sqlite3 >/dev/null; then
    INT="$(sqlite3 "$KOUZIA_DB_PATH" "PRAGMA integrity_check;" 2>/dev/null || echo fail)"
    echo "  Integrity : $INT"
    MIG="$(sqlite3 "$KOUZIA_DB_PATH" "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;" 2>/dev/null || echo "?")"
    echo "  Dernière migration : $MIG"
  fi
else
  warn "DB absente"
fi
echo ""

echo "${C_BOLD}Backups locaux${C_RESET}"
if [[ -d "$KOUZIA_BACKUP_DIR" ]]; then
  COUNT="$(find "$KOUZIA_BACKUP_DIR" -name 'kouziacrm-*.db.gpg' 2>/dev/null | wc -l | tr -d ' ')"
  # Compatible busybox (pas de -printf GNU)
  LAST="$(ls -1t "$KOUZIA_BACKUP_DIR"/kouziacrm-*.db.gpg 2>/dev/null | head -1 || true)"
  echo "  Dir : $KOUZIA_BACKUP_DIR ($COUNT fichiers)"
  echo "  Dernier : ${LAST:-aucun}"
else
  warn "Répertoire backup absent"
fi
load_rsync_conf
echo "  Rsync target : ${KOUZIA_RSYNC_TARGET:-non configuré}"
echo ""

echo "${C_BOLD}Dernière update${C_RESET}"
if [[ -f "${KOUZIA_STATE_DIR}/last-update" ]]; then
  cat "${KOUZIA_STATE_DIR}/last-update"
else
  echo "  (jamais)"
fi
