#!/usr/bin/env bash
# Mise à jour incrémentale KouziaCRM (Alpine) :
#  - backup DB avant toute modification
#  - git pull OU code déjà synchronisé (rsync depuis la machine de dev)
#  - npm ci seulement si package-lock.json a changé
#  - rebuild SPA seulement si le front / forms a changé
#  - prisma generate si schéma changé, migrate deploy toujours
#  - redémarrage OpenRC + healthcheck
#
# Usage :
#   kouziactl update
#   kouziactl update --git
#   kouziactl update --skip-backup
#   kouziactl update --force-deps     # force npm ci
#   kouziactl update --force-web      # force rebuild SPA

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

DO_GIT=0
SKIP_BACKUP=0
FORCE_DEPS=0
FORCE_WEB=0
FORCE_ALL=0
GIT_EXPLICIT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --git) DO_GIT=1; GIT_EXPLICIT=1; shift ;;
    --no-git) DO_GIT=0; GIT_EXPLICIT=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --force-deps) FORCE_DEPS=1; shift ;;
    --force-web) FORCE_WEB=1; shift ;;
    --force) FORCE_ALL=1; FORCE_DEPS=1; FORCE_WEB=1; shift ;;
    -h|--help)
      echo "Usage: update.sh [--git|--no-git] [--skip-backup] [--force-deps] [--force-web] [--force]"
      echo "  Défaut : git pull si $KOUZIA_APP_DIR/.git existe."
      exit 0
      ;;
    *) die "Option inconnue: $1" ;;
  esac
done

# Par défaut : pull GitHub si le CT suit le dépôt (évite 3 commandes manuelles).
if [[ "$GIT_EXPLICIT" -eq 0 ]]; then
  if [[ -d "${KOUZIA_APP_DIR}/.git" ]]; then
    DO_GIT=1
  fi
fi

require_root
require_cmd curl sqlite3 npm npx
disk_guard "$KOUZIA_APP_DIR" 400
[[ -f "${KOUZIA_APP_DIR}/package.json" ]] || die "App introuvable dans $KOUZIA_APP_DIR (lancer install.sh d'abord)."

log "=== KouziaCRM : mise à jour ==="
if [[ "$DO_GIT" -eq 1 ]]; then
  log "Mode : git pull + incrémental"
else
  log "Mode : incrémental local (pas de git pull)"
fi

# --- 1. Backup pré-update ---
if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  if [[ -f "$KOUZIA_DB_PATH" ]]; then
    log "Backup pré-update…"
    bash "${SCRIPT_DIR}/backup.sh" --tag "pre-update" || warn "Backup pré-update échoué (continuité au risque de l'opérateur)."
  else
    warn "Pas encore de DB, skip backup."
  fi
fi

# --- 2. Arrêt tôt (libère SQLite + évite chown pendant écriture) ---
stop_app_stack

# --- 3. Code ---
if [[ "$DO_GIT" -eq 1 ]]; then
  [[ -d "${KOUZIA_APP_DIR}/.git" ]] || die "--git demandé mais pas de dépôt git dans $KOUZIA_APP_DIR"
  log "git pull…"
  run_as_app "cd '$KOUZIA_APP_DIR' && git pull --ff-only"
else
  log "Pas de git pull (code déjà en place ou poussé via rsync). Utiliser --git si besoin."
fi

# Ownership léger (évite chown -R de tout node_modules à chaque update)
log "Permissions data / .env…"
chown -R "${KOUZIA_USER}:${KOUZIA_GROUP}" "$KOUZIA_DATA_DIR" "$KOUZIA_STATE_DIR" 2>/dev/null || true
[[ -f "${KOUZIA_APP_DIR}/.env" ]] && chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "${KOUZIA_APP_DIR}/.env" || true
# Sources app (sans node_modules)
chown -R "${KOUZIA_USER}:${KOUZIA_GROUP}" \
  "${KOUZIA_APP_DIR}/apps" \
  "${KOUZIA_APP_DIR}/packages" \
  "${KOUZIA_APP_DIR}/prisma" \
  "${KOUZIA_APP_DIR}/scripts" \
  2>/dev/null || true

# --- 4. Détection changements ---
log "Calcul des empreintes…"
NEW_LOCK="$(file_sha256 "${KOUZIA_APP_DIR}/package-lock.json")"
OLD_LOCK="$(state_get package-lock)"
NEW_SCHEMA="$(file_sha256 "${KOUZIA_APP_DIR}/prisma/schema.prisma")"
OLD_SCHEMA="$(state_get prisma-schema)"
NEW_WEB="$(tree_sha256 "$KOUZIA_APP_DIR" apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/package.json packages/kouzia-forms)"
OLD_WEB="$(state_get web)"

NEED_DEPS=0
NEED_WEB=0
NEED_PRISMA_GEN=0

[[ "$FORCE_DEPS" -eq 1 || "$NEW_LOCK" != "$OLD_LOCK" ]] && NEED_DEPS=1
[[ "$FORCE_WEB" -eq 1 || "$NEW_WEB" != "$OLD_WEB" || "$NEW_WEB" == "error" || -z "$OLD_WEB" ]] && NEED_WEB=1
[[ "$FORCE_ALL" -eq 1 || "$NEW_SCHEMA" != "$OLD_SCHEMA" || "$NEED_DEPS" -eq 1 ]] && NEED_PRISMA_GEN=1

# Première update réussie jamais enregistrée → forcer SPA + prisma gen
if [[ ! -f "${KOUZIA_STATE_DIR}/last-update" ]]; then
  log "Aucune update précédente réussie : force generate + rebuild SPA."
  NEED_WEB=1
  NEED_PRISMA_GEN=1
fi

log "Décision :"
echo "  deps (npm ci)     : $([[ $NEED_DEPS -eq 1 ]] && echo OUI || echo non)"
echo "  prisma generate   : $([[ $NEED_PRISMA_GEN -eq 1 ]] && echo OUI || echo non)"
echo "  build SPA         : $([[ $NEED_WEB -eq 1 ]] && echo OUI || echo non)"
echo "  migrate deploy    : toujours"

# --- 5. Dépendances ---
if [[ "$NEED_DEPS" -eq 1 ]]; then
  npm_ci_or_install "$KOUZIA_APP_DIR"
else
  ok "package-lock inchangé : skip npm ci"
fi

if [[ "$NEED_PRISMA_GEN" -eq 1 ]]; then
  log "prisma generate…"
  run_as_app "cd '$KOUZIA_APP_DIR' && npx prisma generate"
else
  ok "schéma Prisma inchangé : skip generate"
fi

log "prisma migrate deploy…"
prisma_migrate_deploy "$KOUZIA_APP_DIR"

if [[ "$NEED_WEB" -eq 1 ]]; then
  log "Build SPA…"
  run_as_app "cd '$KOUZIA_APP_DIR' && npm run build -w @kouziacrm/web"
else
  ok "front inchangé : skip build SPA"
fi

# --- 6. Restart + health ---
install_kouziactl_link "${KOUZIA_APP_DIR}/scripts/alpine/kouziactl" /usr/local/bin/kouziactl

log "Redémarrage services…"
# Worker après health : évite le lock SQLite pendant le boot API (tsx + migrations soft).
service_safe kouziacrm-worker stop
service_safe kouziacrm start
sleep 2
if ! wait_health; then
  warn "Healthcheck KO. Logs :"
  tail -n 40 "${KOUZIA_LOG_DIR}/app.log" 2>/dev/null || true
  tail -n 20 "${KOUZIA_LOG_DIR}/app.err" 2>/dev/null || true
  die "Mise à jour terminée mais API unhealthy."
fi
service_safe kouziacrm-worker start
ok "Worker démarré après health OK"

# --- 7. Persister empreintes ---
state_set "package-lock" "$NEW_LOCK"
state_set "prisma-schema" "$NEW_SCHEMA"
state_set "web" "$NEW_WEB"
printf '%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" > "${KOUZIA_STATE_DIR}/last-update"
chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "${KOUZIA_STATE_DIR}/last-update" 2>/dev/null || true

ok "Mise à jour terminée."
echo "  DB : $KOUZIA_DB_PATH"
echo "  Status : kouziactl status"
echo "  UI : hard refresh navigateur (Ctrl+Shift+R) si cache"
