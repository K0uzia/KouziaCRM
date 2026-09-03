#!/usr/bin/env bash
# Helpers partagés pour les scripts Alpine / Proxmox CT.
# shellcheck disable=SC2034

set -euo pipefail

KOUZIA_APP_DIR="${KOUZIA_APP_DIR:-/opt/kouziacrm}"
KOUZIA_USER="${KOUZIA_USER:-kouzia}"
KOUZIA_GROUP="${KOUZIA_GROUP:-kouzia}"
KOUZIA_DATA_DIR="${KOUZIA_DATA_DIR:-${KOUZIA_APP_DIR}/data}"
KOUZIA_DB_PATH="${KOUZIA_DB_PATH:-${KOUZIA_DATA_DIR}/kouziacrm.db}"
KOUZIA_BACKUP_DIR="${KOUZIA_BACKUP_DIR:-/var/backup/kouzia}"
KOUZIA_STATE_DIR="${KOUZIA_STATE_DIR:-${KOUZIA_APP_DIR}/.deploy-state}"
KOUZIA_LOG_DIR="${KOUZIA_LOG_DIR:-/var/log/kouzia}"
KOUZIA_ETC_DIR="${KOUZIA_ETC_DIR:-/etc/kouzia}"
KOUZIA_PASSPHRASE_FILE="${KOUZIA_PASSPHRASE_FILE:-${KOUZIA_ETC_DIR}/backup-pass}"
KOUZIA_RSYNC_CONF="${KOUZIA_RSYNC_CONF:-${KOUZIA_ETC_DIR}/rsync.env}"
KOUZIA_RETENTION_DAYS="${KOUZIA_RETENTION_DAYS:-30}"
KOUZIA_API_PORT="${KOUZIA_API_PORT:-3000}"
KOUZIA_HEALTH_URL="${KOUZIA_HEALTH_URL:-http://127.0.0.1:${KOUZIA_API_PORT}/api/health}"

# Couleurs (désactivées si non-TTY)
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_CYAN=$'\033[36m'
else
  C_RESET= C_BOLD= C_GREEN= C_YELLOW= C_RED= C_CYAN=
fi

log()  { echo "${C_CYAN}[$(date '+%F %T')]${C_RESET} $*"; }
ok()   { echo "${C_GREEN}OK${C_RESET} $*"; }
warn() { echo "${C_YELLOW}WARN${C_RESET} $*" >&2; }
die()  { echo "${C_RED}ERREUR${C_RESET} $*" >&2; exit 1; }

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "Exécuter en root (sudo)."
}

require_alpine() {
  [[ -f /etc/alpine-release ]] || die "Ce script cible Alpine Linux (fichier /etc/alpine-release manquant)."
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "Commande requise introuvable: $c"
  done
}

load_rsync_conf() {
  if [[ -f "$KOUZIA_RSYNC_CONF" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$KOUZIA_RSYNC_CONF"
    set +a
  fi
}

run_as_app() {
  if [[ "$(id -u)" -eq 0 ]]; then
    su -s /bin/bash "$KOUZIA_USER" -c "$*"
  else
    bash -c "$*"
  fi
}

ensure_dirs() {
  mkdir -p \
    "$KOUZIA_APP_DIR" \
    "$KOUZIA_DATA_DIR" \
    "$KOUZIA_BACKUP_DIR" \
    "$KOUZIA_STATE_DIR" \
    "$KOUZIA_LOG_DIR" \
    "$KOUZIA_ETC_DIR" \
    "${KOUZIA_DATA_DIR}/uploads/obligations"
  chown -R "${KOUZIA_USER}:${KOUZIA_GROUP}" \
    "$KOUZIA_APP_DIR" \
    "$KOUZIA_DATA_DIR" \
    "$KOUZIA_STATE_DIR" \
    "$KOUZIA_LOG_DIR" 2>/dev/null || true
  chmod 750 "$KOUZIA_ETC_DIR" "$KOUZIA_BACKUP_DIR"
}

file_sha256() {
  if [[ -f "$1" ]]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "missing"
  fi
}

tree_sha256() {
  # Empreinte stable d'un arbre de fichiers (chemins relatifs triés).
  local root="$1"
  shift
  if [[ ! -d "$root" ]]; then
    echo "missing"
    return
  fi
  (
    cd "$root"
    find "$@" -type f 2>/dev/null \
      | LC_ALL=C sort \
      | xargs -r sha256sum 2>/dev/null \
      | sha256sum \
      | awk '{print $1}'
  )
}

state_get() {
  local key="$1"
  local f="${KOUZIA_STATE_DIR}/${key}.sha"
  [[ -f "$f" ]] && cat "$f" || echo ""
}

state_set() {
  local key="$1" value="$2"
  mkdir -p "$KOUZIA_STATE_DIR"
  printf '%s\n' "$value" > "${KOUZIA_STATE_DIR}/${key}.sha"
  chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "${KOUZIA_STATE_DIR}/${key}.sha" 2>/dev/null || true
}

wait_health() {
  local url="${1:-$KOUZIA_HEALTH_URL}"
  local tries="${2:-30}"
  local i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      ok "Healthcheck: $url"
      return 0
    fi
    sleep 1
  done
  warn "Healthcheck timeout après ${tries}s: $url"
  return 1
}

service_exists() {
  [[ -f "/etc/init.d/$1" ]] || rc-service -e "$1" 2>/dev/null
}

service_safe() {
  # service_safe <name> <start|stop|restart|status>
  local name="$1" action="$2"
  if service_exists "$name"; then
    rc-service "$name" "$action" || true
  else
    warn "Service OpenRC absent: $name"
  fi
}

disk_guard() {
  local path="$1" min_mb="${2:-500}"
  local avail
  avail="$(df -Pm "$path" | awk 'NR==2 {print $4}')"
  if [[ "${avail:-0}" -lt "$min_mb" ]]; then
    die "Espace disque insuffisant sur $path (${avail} Mo libres, minimum ${min_mb} Mo)."
  fi
}
