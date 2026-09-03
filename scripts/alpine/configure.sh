#!/usr/bin/env bash
# Assistant post-install : .env, Cloudflare Tunnel, rsync offsite, récap IP/status.
#
# Usage :
#   kouziactl configure
#   bash scripts/alpine/configure.sh
#   bash scripts/alpine/configure.sh --summary-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

SUMMARY_ONLY=0
SKIP_RESTART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary-only) SUMMARY_ONLY=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    -h|--help)
      echo "Usage: configure.sh [--summary-only] [--skip-restart]"
      exit 0
      ;;
    *) die "Option inconnue: $1" ;;
  esac
done

ENV_FILE="${KOUZIA_APP_DIR}/.env"

detect_ips() {
  # IPv4 non-loopback (busybox ip / ifconfig)
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $4}' | cut -d/ -f1
  elif command -v hostname >/dev/null 2>&1; then
    hostname -i 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true
  fi
}

env_get() {
  local key="$1" def="${2:-}"
  [[ -f "$ENV_FILE" ]] || { echo "$def"; return; }
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  if [[ -z "$line" ]]; then
    echo "$def"
    return
  fi
  echo "${line#*=}" | sed -e 's/^"//' -e 's/"$//'
}

env_set() {
  local key="$1" value="$2"
  [[ -f "$ENV_FILE" ]] || die ".env introuvable: $ENV_FILE"
  KEY="$key" VAL="$value" FILE="$ENV_FILE" node <<'NODE'
const fs = require("fs");
const key = process.env.KEY;
const val = process.env.VAL;
const file = process.env.FILE;
let text = fs.readFileSync(file, "utf8");
const line = `${key}=${JSON.stringify(val)}`;
const re = new RegExp(`^#?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
if (re.test(text)) {
  text = text.replace(re, line);
} else {
  text = text.replace(/\s*$/, "") + "\n" + line + "\n";
}
fs.writeFileSync(file, text);
NODE
  chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "$ENV_FILE" 2>/dev/null || true
  chmod 640 "$ENV_FILE"
}

ask() {
  # ask VAR "Prompt" "default"
  local __var="$1" __prompt="$2" __def="${3:-}"
  local __ans
  if [[ -n "$__def" ]]; then
    echo -n "${__prompt} [${__def}]: "
  else
    echo -n "${__prompt}: "
  fi
  read -r __ans || true
  if [[ -z "$__ans" ]]; then
    __ans="$__def"
  fi
  printf -v "$__var" '%s' "$__ans"
}

ask_secret() {
  local __var="$1" __prompt="$2" __def="${3:-}"
  local __ans
  if [[ -n "$__def" ]]; then
    echo -n "${__prompt} [garder actuel]: "
  else
    echo -n "${__prompt}: "
  fi
  read -r __ans || true
  if [[ -z "$__ans" ]]; then
    __ans="$__def"
  fi
  printf -v "$__var" '%s' "$__ans"
}

yesno() {
  local prompt="$1" def="${2:-n}" ans
  echo -n "${prompt} [y/N]: "
  read -r ans || true
  ans="${ans:-$def}"
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

print_access() {
  local port primary web_origin
  port="$(env_get API_PORT "$KOUZIA_API_PORT")"
  web_origin="$(env_get WEB_ORIGIN "")"
  local IPS=()
  local ip
  while IFS= read -r ip; do
    [[ -n "$ip" ]] && IPS+=("$ip")
  done < <(detect_ips)
  primary="${IPS[0]:-127.0.0.1}"

  echo ""
  echo "${C_BOLD}═══ Accès ERP ═══${C_RESET}"
  echo "  Local (sur le CT)     : http://127.0.0.1:${port}"
  if [[ ${#IPS[@]} -gt 0 ]]; then
    for ip in "${IPS[@]}"; do
      echo "  Réseau LAN            : http://${ip}:${port}"
    done
    echo "  IP principale CT      : ${primary}"
  else
    warn "Aucune IP LAN détectée (vérifier le réseau du CT)."
  fi
  if [[ -n "$web_origin" ]]; then
    echo "  URL publique (WEB_ORIGIN) : ${web_origin}"
  fi
  echo "  Healthcheck           : http://127.0.0.1:${port}/api/health"
  echo ""
}

print_summary() {
  local port admin_email tunnel_token rsync_target
  port="$(env_get API_PORT "$KOUZIA_API_PORT")"
  admin_email="$(env_get ADMIN_EMAIL "")"
  tunnel_token="$(env_get CLOUDFLARE_TUNNEL_TOKEN "")"
  load_rsync_conf
  rsync_target="${KOUZIA_RSYNC_TARGET:-}"

  print_access

  echo "${C_BOLD}═══ Configuration ═══${C_RESET}"
  echo "  App dir     : $KOUZIA_APP_DIR"
  echo "  .env        : $ENV_FILE"
  echo "  WEB_ORIGIN  : $(env_get WEB_ORIGIN)"
  echo "  COOKIE_SECURE / TRUST_PROXY : $(env_get COOKIE_SECURE) / $(env_get TRUST_PROXY)"
  echo "  ADMIN_EMAIL : ${admin_email}"
  echo "  SMTP        : $(env_get SMTP_HOST):$(env_get SMTP_PORT) ($(env_get SMTP_USER))"
  echo "  IMAP        : $(env_get IMAP_HOST) ($(env_get IMAP_USER))"
  if [[ -n "$tunnel_token" ]]; then
    echo "  Cloudflare  : token présent ($( [[ -f /etc/init.d/cloudflared ]] && echo service OK || echo service à vérifier ))"
  else
    echo "  Cloudflare  : non configuré (accès via IP LAN ou reverse-proxy)"
  fi
  echo "  Rsync       : ${rsync_target:-non configuré}"
  echo "  Backups     : $KOUZIA_BACKUP_DIR"
  echo ""

  echo "${C_BOLD}═══ Status services ═══${C_RESET}"
  for svc in kouziacrm kouziacrm-worker cloudflared crond; do
    if service_exists "$svc"; then
      st="$(rc-service "$svc" status 2>&1 | head -1 || true)"
      echo "  $svc : $st"
    fi
  done
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    ok "API healthy sur le port ${port}"
  else
    warn "API ne répond pas encore sur le port ${port}"
  fi
  echo ""
  echo "Compte admin : ${admin_email} (mot de passe dans .env : ADMIN_PASSWORD)"
  echo "Commandes    : kouziactl status | kouziactl backup | kouziactl"
  echo ""
}

configure_env() {
  echo ""
  echo "${C_BOLD}── 1/3 Configuration .env ──${C_RESET}"
  [[ -f "$ENV_FILE" ]] || die ".env manquant: $ENV_FILE"

  local web_origin public_web client_portal site_url
  local admin_email admin_name
  local smtp_host smtp_port smtp_secure smtp_user smtp_pass smtp_from
  local imap_host imap_port imap_user imap_pass
  local api_port

  ask web_origin "URL publique ERP (WEB_ORIGIN, ex. https://gestion.kouzia.fr)" "$(env_get WEB_ORIGIN "https://gestion.kouzia.fr")"
  ask public_web "Site public Kouzia (PUBLIC_WEB_ORIGIN)" "$(env_get PUBLIC_WEB_ORIGIN "https://kouzia.fr")"
  ask client_portal "Portail client /suivi (CLIENT_PORTAL_URL)" "$(env_get CLIENT_PORTAL_URL "https://kouzia.com/suivi")"
  ask site_url "URL site (VITE_PUBLIC_SITE_URL)" "$(env_get VITE_PUBLIC_SITE_URL "$public_web")"
  ask api_port "Port API local (API_PORT)" "$(env_get API_PORT "$KOUZIA_API_PORT")"
  ask admin_email "Email admin" "$(env_get ADMIN_EMAIL "admin@kouzia.com")"
  ask admin_name "Nom admin" "$(env_get ADMIN_NAME "Alexandre Kouziaeff")"

  echo ""
  echo "SMTP (laisser vide pour configurer plus tard dans l'ERP) :"
  ask smtp_host "SMTP_HOST" "$(env_get SMTP_HOST "")"
  ask smtp_port "SMTP_PORT" "$(env_get SMTP_PORT "465")"
  ask smtp_secure "SMTP_SECURE (true/false)" "$(env_get SMTP_SECURE "true")"
  ask smtp_user "SMTP_USER" "$(env_get SMTP_USER "")"
  ask_secret smtp_pass "SMTP_PASS" "$(env_get SMTP_PASS "")"
  ask smtp_from "SMTP_FROM" "$(env_get SMTP_FROM "KOUZIA <contact@kouzia.com>")"

  echo ""
  echo "IMAP (optionnel, worker) :"
  ask imap_host "IMAP_HOST" "$(env_get IMAP_HOST "")"
  ask imap_port "IMAP_PORT" "$(env_get IMAP_PORT "993")"
  ask imap_user "IMAP_USER" "$(env_get IMAP_USER "")"
  ask_secret imap_pass "IMAP_PASS" "$(env_get IMAP_PASS "")"

  env_set WEB_ORIGIN "$web_origin"
  env_set PUBLIC_WEB_ORIGIN "$public_web"
  env_set CLIENT_PORTAL_URL "$client_portal"
  env_set VITE_PUBLIC_SITE_URL "$site_url"
  env_set API_PORT "$api_port"
  env_set WEB_DIST "${KOUZIA_APP_DIR}/apps/web/dist"
  env_set NODE_ENV "production"
  env_set COOKIE_SECURE "true"
  env_set TRUST_PROXY "true"
  env_set PUBLIC_API_ORIGIN "$web_origin"
  env_set ADMIN_EMAIL "$admin_email"
  env_set ADMIN_NAME "$admin_name"
  env_set SMTP_HOST "$smtp_host"
  env_set SMTP_PORT "$smtp_port"
  env_set SMTP_SECURE "$smtp_secure"
  env_set SMTP_USER "$smtp_user"
  env_set SMTP_PASS "$smtp_pass"
  env_set SMTP_FROM "$smtp_from"
  env_set IMAP_HOST "$imap_host"
  env_set IMAP_PORT "$imap_port"
  env_set IMAP_SECURE "true"
  env_set IMAP_USER "$imap_user"
  env_set IMAP_PASS "$imap_pass"
  env_set IMAP_MAILBOX "INBOX"

  KOUZIA_API_PORT="$api_port"
  KOUZIA_HEALTH_URL="http://127.0.0.1:${api_port}/api/health"
  ok ".env mis à jour"
}

configure_cloudflare() {
  echo ""
  echo "${C_BOLD}── 2/3 Cloudflare Tunnel ──${C_RESET}"
  echo "Dans Cloudflare Zero Trust → Networks → Tunnels :"
  echo "  1. Créer un tunnel (cloudflared)"
  echo "  2. Public hostname → votre WEB_ORIGIN (ex. gestion.kouzia.fr)"
  echo "  3. Service : http://127.0.0.1:$(env_get API_PORT "$KOUZIA_API_PORT")"
  echo "  4. Copier le token d'installation du tunnel"
  echo ""

  if ! yesno "Configurer Cloudflare Tunnel maintenant ?"; then
    warn "Cloudflare ignoré (accès possible via IP LAN)."
    return 0
  fi

  local token
  ask_secret token "CLOUDFLARE_TUNNEL_TOKEN" "$(env_get CLOUDFLARE_TUNNEL_TOKEN "")"
  [[ -n "$token" ]] || { warn "Token vide, skip."; return 0; }
  env_set CLOUDFLARE_TUNNEL_TOKEN "$token"

  log "Installation cloudflared…"
  if ! command -v cloudflared >/dev/null 2>&1; then
    # Binaire officiel Cloudflare (Alpine musl x86_64)
    local arch
    arch="$(uname -m)"
    local url=""
    case "$arch" in
      x86_64|amd64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
      aarch64|arm64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
      *) warn "Arch $arch non gérée pour cloudflared auto-install."; return 0 ;;
    esac
    curl -fsSL "$url" -o /usr/local/bin/cloudflared
    chmod 755 /usr/local/bin/cloudflared
  fi
  ok "cloudflared $(cloudflared --version 2>/dev/null | head -1 || echo installé)"

  install -m 755 "${SCRIPT_DIR}/openrc/cloudflared" /etc/init.d/cloudflared
  cat > /etc/conf.d/cloudflared <<EOF
CLOUDFLARE_TUNNEL_TOKEN="${token}"
EOF
  chmod 600 /etc/conf.d/cloudflared

  rc-update add cloudflared default 2>/dev/null || true
  rc-service cloudflared restart 2>/dev/null || rc-service cloudflared start
  ok "Service cloudflared démarré"
  echo "Vérifier le hostname dans Cloudflare Zero Trust (status Healthy)."
}

configure_rsync() {
  echo ""
  echo "${C_BOLD}── 3/3 Backup rsync offsite ──${C_RESET}"
  echo "Pousse les backups chiffrés (.db.gpg) vers un NAS / autre hôte."
  echo "Ex. : backup@192.168.1.10:/volume1/backups/kouzia/"
  echo ""

  if ! yesno "Configurer rsync offsite maintenant ?"; then
    warn "Rsync offsite ignoré (backups locaux uniquement dans $KOUZIA_BACKUP_DIR)."
    return 0
  fi

  mkdir -p "$KOUZIA_ETC_DIR"
  local target ssh_cmd delete
  ask target "KOUZIA_RSYNC_TARGET" "$(grep -E '^KOUZIA_RSYNC_TARGET=' "$KOUZIA_RSYNC_CONF" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  ask ssh_cmd "SSH custom (KOUZIA_RSYNC_SSH, vide = ssh défaut)" "$(grep -E '^KOUZIA_RSYNC_SSH=' "$KOUZIA_RSYNC_CONF" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  ask delete "KOUZIA_RSYNC_DELETE (0/1)" "0"

  cat > "$KOUZIA_RSYNC_CONF" <<EOF
# Généré par configure.sh - $(date '+%Y-%m-%dT%H:%M:%S%z')
KOUZIA_RSYNC_TARGET="${target}"
KOUZIA_RSYNC_SSH="${ssh_cmd}"
KOUZIA_RSYNC_DELETE="${delete}"
EOF
  chmod 600 "$KOUZIA_RSYNC_CONF"
  ok "Écrit $KOUZIA_RSYNC_CONF"

  if [[ -n "$target" ]] && yesno "Tester un backup + rsync maintenant ?"; then
    bash "${SCRIPT_DIR}/backup.sh" || warn "Backup/rsync a échoué (vérifier SSH/cible)."
  fi
}

restart_stack() {
  [[ "$SKIP_RESTART" -eq 1 ]] && return 0
  log "Redémarrage des services pour appliquer .env…"
  service_safe kouziacrm restart
  service_safe kouziacrm-worker restart
  sleep 1
  wait_health || warn "Healthcheck KO après restart"
}

# --- main ---
if [[ "$SUMMARY_ONLY" -eq 1 ]]; then
  print_summary
  exit 0
fi

if [[ ! -t 0 ]]; then
  warn "Pas de TTY : skip wizard. Relancer : kouziactl configure"
  print_summary
  exit 0
fi

require_root
[[ -d "$KOUZIA_APP_DIR" ]] || die "App absente: $KOUZIA_APP_DIR"

echo ""
echo "${C_BOLD}Assistant de configuration KouziaCRM${C_RESET}"
print_access

configure_env
configure_cloudflare
configure_rsync
restart_stack
print_summary

ok "Configuration terminée."
