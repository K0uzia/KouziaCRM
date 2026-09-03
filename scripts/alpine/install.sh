#!/usr/bin/env bash
# Installation KouziaCRM sur CT Proxmox Alpine (natif, sans Docker).
#
# Préférer le menu :
#   bash /opt/kouziacrm/scripts/alpine/kouziactl
#   kouziactl
#
# Install non interactive :
#   bash scripts/alpine/install.sh --yes [--skip-seed] [--no-start]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sans option en TTY → menu (ne lance pas l'install directement)
if [[ $# -eq 0 && -t 0 && "${KOUZIA_FORCE_INSTALL:-0}" != "1" ]]; then
  exec bash "${SCRIPT_DIR}/kouziactl"
fi

# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

REPO_URL="${KOUZIA_REPO_URL:-https://github.com/K0uzia/KouziaCRM.git}"
REPO_BRANCH="${KOUZIA_REPO_BRANCH:-main}"
SKIP_SEED=0
NO_START=0
SKIP_WIZARD=0
SEED_FROM_DIR=""

usage() {
  cat <<EOF
Usage: $(basename "$0") --yes [options]

Options:
  --yes               Confirmer l'installation (obligatoire hors menu)
  --repo URL          URL git du dépôt (défaut: $REPO_URL)
  --branch NAME       Branche à cloner (défaut: $REPO_BRANCH)
  --from DIR          Installer depuis un dossier local (rsync) au lieu de git
  --app-dir DIR       Répertoire d'install (défaut: $KOUZIA_APP_DIR)
  --skip-seed         Ne pas exécuter le seed Prisma
  --no-start          Installer sans démarrer les services
  --skip-wizard       Ne pas lancer l'assistant .env / Cloudflare / rsync
  -h, --help          Aide

Sans argument en terminal interactif : ouvre le menu kouziactl.
EOF
}

YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) REPO_BRANCH="$2"; shift 2 ;;
    --from) SEED_FROM_DIR="$2"; shift 2 ;;
    --app-dir) KOUZIA_APP_DIR="$2"; KOUZIA_DATA_DIR="${KOUZIA_APP_DIR}/data"; KOUZIA_DB_PATH="${KOUZIA_DATA_DIR}/kouziacrm.db"; KOUZIA_STATE_DIR="${KOUZIA_APP_DIR}/.deploy-state"; shift 2 ;;
    --skip-seed) SKIP_SEED=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --skip-wizard) SKIP_WIZARD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Option inconnue: $1" ;;
  esac
done

if [[ "$YES" -ne 1 && "${KOUZIA_FORCE_INSTALL:-0}" != "1" ]]; then
  die "Installation refusée sans --yes (utilisez kouziactl pour le menu)."
fi

require_root
require_alpine
disk_guard / 1024

log "=== KouziaCRM : installation Alpine CT ==="
log "App dir : $KOUZIA_APP_DIR"

# --- Packages système ---
log "Installation des paquets apk…"
apk update
apk add --no-cache \
  bash curl git rsync gnupg openssl sqlite \
  nodejs npm \
  python3 make g++ linux-headers \
  ca-certificates tzdata \
  logrotate shadow iproute2

# Node 20+ requis
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  warn "Node $NODE_MAJOR détecté (< 20). Tentative nodejs-current…"
  apk add --no-cache nodejs-current npm || die "Node.js >= 20 requis. Passez Alpine 3.21+ ou installez Node manuellement."
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  [[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js toujours < 20 après nodejs-current."
fi
ok "Node $(node -v) / npm $(npm -v)"

# --- Utilisateur dédié ---
if ! id -u "$KOUZIA_USER" >/dev/null 2>&1; then
  log "Création utilisateur $KOUZIA_USER…"
  addgroup -S "$KOUZIA_GROUP" 2>/dev/null || true
  adduser -S -D -H -h "$KOUZIA_APP_DIR" -s /sbin/nologin -G "$KOUZIA_GROUP" "$KOUZIA_USER"
fi
ensure_dirs

# --- Code source ---
if [[ -n "$SEED_FROM_DIR" ]]; then
  [[ -d "$SEED_FROM_DIR" ]] || die "Dossier source introuvable: $SEED_FROM_DIR"
  log "Rsync depuis $SEED_FROM_DIR → $KOUZIA_APP_DIR…"
  rsync -a --delete \
    --exclude-from="${SCRIPT_DIR}/conf/rsync-exclude.txt" \
    "${SEED_FROM_DIR}/" "${KOUZIA_APP_DIR}/"
elif [[ -d "${KOUZIA_APP_DIR}/.git" ]]; then
  log "Dépôt déjà présent, git pull…"
  run_as_app "cd '$KOUZIA_APP_DIR' && git fetch --depth 1 origin '$REPO_BRANCH' && git checkout '$REPO_BRANCH' && git pull --ff-only origin '$REPO_BRANCH'"
elif [[ -f "${KOUZIA_APP_DIR}/package.json" ]]; then
  log "Code déjà présent (sans .git), conservation."
else
  log "Clone $REPO_URL ($REPO_BRANCH)…"
  # Clone dans un tmp puis move pour éviter un APP_DIR non vide
  TMP_CLONE="$(mktemp -d)"
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$TMP_CLONE/repo"
  rsync -a --exclude data --exclude .env "$TMP_CLONE/repo/" "${KOUZIA_APP_DIR}/"
  rm -rf "$TMP_CLONE"
fi

chown -R "${KOUZIA_USER}:${KOUZIA_GROUP}" "$KOUZIA_APP_DIR"
mkdir -p "$KOUZIA_DATA_DIR/uploads/obligations"
chown -R "${KOUZIA_USER}:${KOUZIA_GROUP}" "$KOUZIA_DATA_DIR"

# --- Secrets / .env ---
ENV_FILE="${KOUZIA_APP_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Génération .env production…"
  SESSION_SECRET="$(openssl rand -base64 32)"
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  ONBOARDING_HMAC="$(openssl rand -hex 32)"
  ADMIN_PASSWORD="$(openssl rand -base64 24)"
  cat > "$ENV_FILE" <<EOF
# Généré par scripts/alpine/install.sh - $(date '+%Y-%m-%dT%H:%M:%S%z')
DATABASE_URL="file:../data/kouziacrm.db"
SESSION_SECRET="${SESSION_SECRET}"
ENCRYPTION_KEY="${ENCRYPTION_KEY}"
ONBOARDING_HMAC_SECRET="${ONBOARDING_HMAC}"
ONBOARDING_TOKEN_TTL_DAYS="7"

# Adapter à votre tunnel / domaine
WEB_ORIGIN="https://gestion.kouzia.fr"
PUBLIC_WEB_ORIGIN="https://kouzia.fr"
CLIENT_PORTAL_URL="https://kouzia.com/suivi"
VITE_PUBLIC_SITE_URL="https://kouzia.fr"
COOKIE_SECURE="true"
TRUST_PROXY="true"
API_PORT="${KOUZIA_API_PORT}"
WEB_DIST="${KOUZIA_APP_DIR}/apps/web/dist"
NODE_ENV="production"

ADMIN_EMAIL="admin@kouzia.com"
ADMIN_PASSWORD="${ADMIN_PASSWORD}"
ADMIN_NAME="Alexandre Kouziaeff"

SMTP_HOST=""
SMTP_PORT="465"
SMTP_SECURE="true"
SMTP_USER=""
SMTP_PASS=""
SMTP_FROM="KOUZIA <contact@kouzia.com>"

IMAP_HOST=""
IMAP_PORT="993"
IMAP_SECURE="true"
IMAP_USER=""
IMAP_PASS=""
IMAP_MAILBOX="INBOX"

# CLOUDFLARE_TUNNEL_TOKEN=""
EOF
  chmod 640 "$ENV_FILE"
  chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "$ENV_FILE"
  ok ".env créé (secrets générés)."
  warn "Noter ADMIN_PASSWORD maintenant (affiché une seule fois) :"
  echo "    ADMIN_PASSWORD=${ADMIN_PASSWORD}"
  echo ""
  warn "L'assistant post-install configurera WEB_ORIGIN / SMTP / Cloudflare / rsync."
else
  ok ".env existant conservé."
fi

# --- Passphrase backup ---
if [[ ! -f "$KOUZIA_PASSPHRASE_FILE" ]]; then
  openssl rand -base64 32 > "$KOUZIA_PASSPHRASE_FILE"
  chmod 600 "$KOUZIA_PASSPHRASE_FILE"
  ok "Passphrase backup : $KOUZIA_PASSPHRASE_FILE"
fi

# --- Conf rsync (template) ---
if [[ ! -f "$KOUZIA_RSYNC_CONF" ]]; then
  cp "${SCRIPT_DIR}/conf/rsync.env.example" "$KOUZIA_RSYNC_CONF"
  chmod 600 "$KOUZIA_RSYNC_CONF"
  ok "Template rsync : $KOUZIA_RSYNC_CONF (à renseigner pour offsite)"
fi

# --- Dépendances Node + build ---
npm_ci_or_install "$KOUZIA_APP_DIR"
log "Prisma generate + migrate deploy…"
run_as_app "cd '$KOUZIA_APP_DIR' && npx prisma generate && npx prisma migrate deploy"
if [[ "$SKIP_SEED" -eq 0 ]]; then
  if [[ -f "$KOUZIA_DB_PATH" ]] && [[ -s "$KOUZIA_DB_PATH" ]]; then
    # Base déjà peuplée : seed idempotent ou skip
    log "Base existante détectée, seed (idempotent)…"
  fi
  run_as_app "cd '$KOUZIA_APP_DIR' && npm run db:seed" || warn "Seed échoué (compte admin déjà présent ?). Continuer."
fi
log "Build SPA…"
run_as_app "cd '$KOUZIA_APP_DIR' && npm run build -w @kouziacrm/web"

# Empreintes pour update incrémental
state_set "package-lock" "$(file_sha256 "${KOUZIA_APP_DIR}/package-lock.json")"
state_set "prisma-schema" "$(file_sha256 "${KOUZIA_APP_DIR}/prisma/schema.prisma")"
state_set "web" "$(tree_sha256 "$KOUZIA_APP_DIR" apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/tailwind.config.ts apps/web/package.json packages/kouzia-forms)"

# --- OpenRC ---
log "Installation services OpenRC…"
install -m 755 "${SCRIPT_DIR}/openrc/kouziacrm" /etc/init.d/kouziacrm
install -m 755 "${SCRIPT_DIR}/openrc/kouziacrm-worker" /etc/init.d/kouziacrm-worker

# Variables injectées dans les scripts OpenRC via conf.d
cat > /etc/conf.d/kouziacrm <<EOF
KOUZIA_APP_DIR="${KOUZIA_APP_DIR}"
KOUZIA_USER="${KOUZIA_USER}"
KOUZIA_GROUP="${KOUZIA_GROUP}"
EOF
cp /etc/conf.d/kouziacrm /etc/conf.d/kouziacrm-worker

rc-update add kouziacrm default
rc-update add kouziacrm-worker default

# --- CLI (résout /opt/kouziacrm/scripts/alpine si copié hors du dépôt) ---
install -m 755 "${KOUZIA_APP_DIR}/scripts/alpine/kouziactl" /usr/local/bin/kouziactl

# --- Cron backup + logrotate ---
install -m 644 "${SCRIPT_DIR}/conf/logrotate.kouzia" /etc/logrotate.d/kouzia
CRON_FILE="/etc/periodic/daily/kouzia-backup"
cat > "$CRON_FILE" <<EOF
#!/bin/sh
# Backup quotidien KouziaCRM (Alpine busybox crond : /etc/periodic/daily)
exec ${KOUZIA_APP_DIR}/scripts/alpine/backup.sh
EOF
chmod 755 "$CRON_FILE"
# S'assurer que crond tourne
rc-update add crond default 2>/dev/null || true
rc-service crond start 2>/dev/null || true

# --- Démarrage ---
if [[ "$NO_START" -eq 0 ]]; then
  log "Démarrage des services…"
  rc-service kouziacrm start
  rc-service kouziacrm-worker start
  wait_health || warn "L'API ne répond pas encore : rc-service kouziacrm status / tail ${KOUZIA_LOG_DIR}/app.log"
else
  warn "Services non démarrés (--no-start)."
fi

# --- Assistant post-install (.env, Cloudflare, rsync) + récap IP ---
if [[ "$SKIP_WIZARD" -eq 0 && -t 0 ]]; then
  echo ""
  log "Lancement de l'assistant de configuration…"
  bash "${SCRIPT_DIR}/configure.sh" || warn "Assistant interrompu. Relancer : kouziactl configure"
else
  bash "${SCRIPT_DIR}/configure.sh" --summary-only || true
  if [[ "$SKIP_WIZARD" -eq 1 ]]; then
    warn "Wizard skip (--skip-wizard). Configurer plus tard : kouziactl configure"
  fi
fi
