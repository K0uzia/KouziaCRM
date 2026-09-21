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

# git dans le dépôt app : OK en root (safe.directory) sans toucher git config.
git_in_app() {
  git -c "safe.directory=${KOUZIA_APP_DIR}" -C "$KOUZIA_APP_DIR" "$@"
}

# Aligne le code du CT sur origin/$branch (GitHub = source de vérité).
# Conservé : .env, data/ (gitignore). Écrasé : commits locaux, lockfile musl, etc.
git_sync_from_origin() {
  local branch="${1:-main}"
  [[ -d "${KOUZIA_APP_DIR}/.git" ]] || die "Pas de dépôt git dans $KOUZIA_APP_DIR"

  log "git fetch origin/${branch}…"
  run_as_app "cd '$KOUZIA_APP_DIR' && git fetch --depth 1 origin '+${branch}:refs/remotes/origin/${branch}'" \
    || die "git fetch origin/${branch} échoué."

  if ! git_in_app diff --quiet || ! git_in_app diff --cached --quiet; then
    warn "Modifications locales suivies (ex. package-lock) : écrasées par origin/${branch}."
  fi
  if ! git_in_app merge-base --is-ancestor HEAD "origin/${branch}" 2>/dev/null; then
    warn "Branche locale divergée de origin/${branch} : reset dur (commits locaux du CT ignorés)."
  fi

  run_as_app "cd '$KOUZIA_APP_DIR' && (git show-ref --verify --quiet 'refs/heads/${branch}' && git checkout -f '${branch}' || git checkout -f -B '${branch}' 'origin/${branch}') && git reset --hard 'origin/${branch}'" \
    || die "git reset origin/${branch} échoué."

  ok "HEAD = $(git_in_app rev-parse --short HEAD) (origin/${branch})"
}

# SPA production : Vite seul. tsc -b casse si node_modules partiel (types react-router).
build_spa() {
  local dir="${1:-$KOUZIA_APP_DIR}"
  log "Build SPA (vite)…"
  run_as_app "cd '$dir' && npm run build:spa -w @kouziacrm/web"
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
  # Compatible BusyBox Alpine (pas de xargs -r GNU).
  local root="$1"
  shift
  if [[ ! -d "$root" ]]; then
    echo "missing"
    return 0
  fi
  (
    set +e
    cd "$root" || {
      echo "missing"
      exit 0
    }
    local list
    list="$(find "$@" -type f 2>/dev/null | LC_ALL=C sort)"
    if [[ -z "${list}" ]]; then
      echo "empty"
      exit 0
    fi
    printf '%s\n' "${list}" | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
  ) || echo "error"
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
  local env_port
  env_port="$(grep -E '^API_PORT=' "${KOUZIA_APP_DIR}/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  local port="${env_port:-$KOUZIA_API_PORT}"
  local url="${1:-http://127.0.0.1:${port}/api/health}"
  local tries="${2:-90}"
  local i
  local err=""
  for ((i = 1; i <= tries; i++)); do
    # -4 : forcer IPv4 (Alpine / curl peut tenter ::1 et échouer)
    if err="$(curl -4 -fsS --connect-timeout 2 --max-time 5 "$url" 2>&1)"; then
      ok "Healthcheck: $url"
      return 0
    fi
    sleep 1
  done
  warn "Healthcheck timeout après ${tries}s: $url"
  if [[ -n "$err" ]]; then
    warn "Dernière erreur curl : $err"
  fi
  # Diagnostic rapide
  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | grep -E ":${port}\\b" || warn "Aucun process en écoute sur :${port}"
  fi
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

# Arrête app + worker pour libérer le verrou SQLite (WAL).
stop_app_stack() {
  log "Arrêt app/worker (libération SQLite)…"
  service_safe kouziacrm-worker stop
  service_safe kouziacrm stop
  local i
  for ((i = 1; i <= 15; i++)); do
    if ! pgrep -f "tsx.*(apps/api/src/index\\.ts|scripts/worker\\.ts)" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if pgrep -f "tsx.*(apps/api/src/index\\.ts|scripts/worker\\.ts)" >/dev/null 2>&1; then
    warn "Processus tsx encore présents, kill…"
    pkill -f "tsx.*apps/api/src/index\\.ts" 2>/dev/null || true
    pkill -f "tsx.*scripts/worker\\.ts" 2>/dev/null || true
    sleep 1
  fi
}

# prisma migrate avec retry si "database is locked"
prisma_migrate_deploy() {
  local dir="${1:-$KOUZIA_APP_DIR}"
  local attempt
  for attempt in 1 2 3 4 5; do
    if run_as_app "cd '$dir' && npx prisma migrate deploy"; then
      ok "prisma migrate deploy OK"
      return 0
    fi
    warn "migrate deploy échoué (tentative ${attempt}/5) : arrêt services + retry…"
    stop_app_stack
    sleep 2
  done
  die "prisma migrate deploy a échoué (SQLite locked ou erreur migration)."
}

disk_guard() {
  local path="$1" min_mb="${2:-500}"
  local avail
  avail="$(df -Pm "$path" | awk 'NR==2 {print $4}')"
  if [[ "${avail:-0}" -lt "$min_mb" ]]; then
    die "Espace disque insuffisant sur $path (${avail} Mo libres, minimum ${min_mb} Mo)."
  fi
}

# Symlink PATH → script du dépôt (évite une copie figée désynchronisée).
install_kouziactl_link() {
  local target="${1:-${KOUZIA_APP_DIR}/scripts/alpine/kouziactl}"
  local link="${2:-/usr/local/bin/kouziactl}"
  [[ -f "$target" ]] || die "kouziactl introuvable: $target"
  chmod +x "$target" 2>/dev/null || true
  mkdir -p "$(dirname "$link")"
  ln -sfn "$target" "$link"
  ok "Commande kouziactl → $target"
}

# npm ci strict ; fallback propre si lockfile / plateforme (ex. Alpine musl + npm 11).
# --include=dev : vite/typescript indispensables au build SPA, même si NODE_ENV=production.
npm_ci_or_install() {
  local dir="${1:-$KOUZIA_APP_DIR}"
  log "npm ci dans $dir…"
  if run_as_app "cd '$dir' && npm ci --include=dev"; then
    ok "npm ci terminé"
    return 0
  fi
  warn "npm ci a échoué : fallback npm install propre (lockfile / plateforme)."
  run_as_app "cd '$dir' && rm -rf node_modules apps/*/node_modules packages/*/node_modules && npm install --include=dev"
  ok "npm install terminé"
}
