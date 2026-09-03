#!/usr/bin/env bash
# Assistant post-install : profil d'accès, admin, site kouzia.com, SMTP,
# Cloudflare (optionnel), rsync offsite, récap IP/status.
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
NEED_WEB_REBUILD=0
# Section: all | access | admin | site | mail | cloudflare | rsync
SECTION="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary-only) SUMMARY_ONLY=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --section)
      SECTION="$2"
      shift 2
      ;;
    all|access|admin|site|public|mail|email|smtp|cloudflare|tunnel|rsync)
      SECTION="$1"
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: configure.sh [section] [--skip-restart] [--summary-only]

Sections :
  all          Assistant complet (défaut)
  access       WEB_ORIGIN, API_PORT, COOKIE_SECURE / TRUST_PROXY
  admin        Email + mot de passe admin (+ seed)
  site         PUBLIC_WEB_ORIGIN, CLIENT_PORTAL_URL, VITE_PUBLIC_SITE_URL
  mail         SMTP / IMAP
  cloudflare   Token tunnel + service cloudflared
  rsync        Cible backup offsite

Exemples :
  configure.sh
  configure.sh cloudflare
  configure.sh --section admin
EOF
      exit 0
      ;;
    *) die "Option/section inconnue: $1 (configure.sh --help)" ;;
  esac
done

case "$SECTION" in
  public) SECTION="site" ;;
  email|smtp) SECTION="mail" ;;
  tunnel) SECTION="cloudflare" ;;
esac

ENV_FILE="${KOUZIA_APP_DIR}/.env"

detect_ips() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $4}' | cut -d/ -f1
  elif command -v hostname >/dev/null 2>&1; then
    hostname -i 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true
  fi
}

primary_ip() {
  local ip
  ip="$(detect_ips | head -1 || true)"
  echo "${ip:-127.0.0.1}"
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
  # JSON-style quotes from env_set, ou quotes simples
  echo "${line#*=}" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
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
  local __var="$1" __prompt="$2" __def="${3:-}"
  local __ans
  if [[ -n "$__def" ]]; then
    echo -n "  ${__prompt}"
    echo -n " [${__def}]: "
  else
    echo -n "  ${__prompt}: "
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
    echo -n "  ${__prompt} [Entrée = garder l'actuel]: "
  else
    echo -n "  ${__prompt}: "
  fi
  # -s masque la saisie si TTY
  if [[ -t 0 ]]; then
    read -rs __ans || true
    echo ""
  else
    read -r __ans || true
  fi
  if [[ -z "$__ans" ]]; then
    __ans="$__def"
  fi
  printf -v "$__var" '%s' "$__ans"
}

yesno() {
  local prompt="$1" def="${2:-n}" ans hint
  if [[ "$def" == "y" || "$def" == "Y" ]]; then
    hint="[Y/n]"
  else
    hint="[y/N]"
  fi
  echo -n "  ${prompt} ${hint}: "
  read -r ans || true
  ans="${ans:-$def}"
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

section() {
  echo ""
  echo "${C_BOLD}── $1 ──${C_RESET}"
  if [[ -n "${2:-}" ]]; then
    echo "  $2"
    echo ""
  fi
}

print_access() {
  local port web_origin
  port="$(env_get API_PORT "$KOUZIA_API_PORT")"
  web_origin="$(env_get WEB_ORIGIN "")"
  local IPS=()
  local ip
  while IFS= read -r ip; do
    [[ -n "$ip" ]] && IPS+=("$ip")
  done < <(detect_ips)

  echo ""
  echo "${C_BOLD}═══ Accès ERP (admin) ═══${C_RESET}"
  echo "  Sur le CT          : http://127.0.0.1:${port}"
  if [[ ${#IPS[@]} -gt 0 ]]; then
    for ip in "${IPS[@]}"; do
      echo "  Depuis le LAN      : http://${ip}:${port}"
    done
  else
    warn "Aucune IP LAN détectée."
  fi
  if [[ -n "$web_origin" ]]; then
    echo "  WEB_ORIGIN (CORS)  : ${web_origin}"
  fi
  echo "  Healthcheck        : http://127.0.0.1:${port}/api/health"
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
  echo "  Mode cookies       : COOKIE_SECURE=$(env_get COOKIE_SECURE)  TRUST_PROXY=$(env_get TRUST_PROXY)"
  echo "  Admin ERP          : ${admin_email}"
  echo "  Site public        : $(env_get PUBLIC_WEB_ORIGIN)"
  echo "  Portail /suivi     : $(env_get CLIENT_PORTAL_URL)"
  echo "  SMTP               : $(env_get SMTP_HOST):$(env_get SMTP_PORT) ($(env_get SMTP_USER))"
  echo "  IMAP               : $(env_get IMAP_HOST) ($(env_get IMAP_USER))"
  if [[ -n "$tunnel_token" ]]; then
    echo "  Cloudflare Tunnel  : token présent"
  else
    echo "  Cloudflare Tunnel  : non (API joignable seulement en LAN)"
  fi
  echo "  Rsync offsite      : ${rsync_target:-non (backups locaux seulement)}"
  echo "  Backups locaux     : $KOUZIA_BACKUP_DIR"
  echo ""

  echo "${C_BOLD}═══ Services ═══${C_RESET}"
  for svc in kouziacrm kouziacrm-worker cloudflared crond; do
    if service_exists "$svc"; then
      st="$(rc-service "$svc" status 2>&1 | head -1 || true)"
      echo "  $svc : $st"
    fi
  done
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    ok "API healthy (port ${port})"
  else
    warn "API ne répond pas sur le port ${port}"
  fi
  echo ""
  echo "  Connexion ERP : ${admin_email} / (mot de passe défini à l'étape Admin)"
  echo "  Ouvrir        : http://$(primary_ip):${port}"
  echo "  Menu          : kouziactl"
  echo ""
}

# --- Étapes ---

choose_profile() {
  section "1/6  Profil d'accès" \
    "L'ERP admin reste privé. kouzia.com (site public) appelle l'API /api/public/*."
  echo "  1) Local LAN seulement"
  echo "     → Admin en http://IP:port  |  pas de HTTPS  |  kouzia.com ne joindra l'API que si elle est exposée autrement"
  echo "  2) LAN + Cloudflare Tunnel"
  echo "     → Admin en LAN HTTP  |  API joignable depuis Internet via tunnel (pour kouzia.com / webhooks)"
  echo ""
  local choice
  ask choice "Choix" "1"
  case "$choice" in
    2) PROFILE="tunnel" ;;
    *) PROFILE="lan" ;;
  esac
  ok "Profil : $PROFILE"
}

configure_access() {
  section "2/6  Accès admin (WEB_ORIGIN + port)" \
    "WEB_ORIGIN = l'URL exacte que tu tapes dans le navigateur pour l'ERP (CORS + cookies). Pas un faux domaine."

  local lan_ip api_port def_origin
  lan_ip="$(primary_ip)"
  api_port="$(env_get API_PORT "$KOUZIA_API_PORT")"
  def_origin="$(env_get WEB_ORIGIN "http://${lan_ip}:${api_port}")"
  # Si l'ancien défaut était un HTTPS inventé, proposer l'IP LAN
  if [[ "$def_origin" == https://gestion.* ]] || [[ "$def_origin" == "https://gestion.kouzia.fr" ]]; then
    def_origin="http://${lan_ip}:${api_port}"
  fi

  ask api_port "Port d'écoute local (API_PORT)" "$api_port"
  ask web_origin "URL d'ouverture de l'ERP (WEB_ORIGIN)" "http://${lan_ip}:${api_port}"

  env_set API_PORT "$api_port"
  env_set WEB_ORIGIN "$web_origin"
  env_set WEB_DIST "${KOUZIA_APP_DIR}/apps/web/dist"
  env_set NODE_ENV "production"
  env_set PUBLIC_API_ORIGIN "$web_origin"

  if [[ "$PROFILE" == "tunnel" ]]; then
    env_set COOKIE_SECURE "false"
    env_set TRUST_PROXY "true"
    echo "  → COOKIE_SECURE=false (admin en HTTP LAN) ; TRUST_PROXY=true (tunnel)"
  else
    env_set COOKIE_SECURE "false"
    env_set TRUST_PROXY "false"
    echo "  → COOKIE_SECURE=false ; TRUST_PROXY=false (HTTP LAN pur)"
  fi

  KOUZIA_API_PORT="$api_port"
  KOUZIA_HEALTH_URL="http://127.0.0.1:${api_port}/api/health"
  ok "Accès admin enregistré"
}

configure_admin() {
  section "3/6  Compte admin ERP" \
    "Email + mot de passe pour te connecter à l'interface. Le seed met à jour le hash en base."

  local admin_email admin_name admin_pass admin_pass2
  ask admin_email "Email admin" "$(env_get ADMIN_EMAIL "admin@kouzia.com")"
  ask admin_name "Nom affiché" "$(env_get ADMIN_NAME "Alexandre Kouziaeff")"

  while true; do
    ask_secret admin_pass "Mot de passe admin (>= 12 caractères)" "$(env_get ADMIN_PASSWORD "")"
    if [[ ${#admin_pass} -lt 12 ]]; then
      warn "Trop court (${#admin_pass} < 12). Réessaie."
      continue
    fi
    ask_secret admin_pass2 "Confirmer le mot de passe" ""
    if [[ "$admin_pass" != "$admin_pass2" ]]; then
      warn "Les mots de passe ne correspondent pas."
      continue
    fi
    break
  done

  env_set ADMIN_EMAIL "$admin_email"
  env_set ADMIN_NAME "$admin_name"
  env_set ADMIN_PASSWORD "$admin_pass"

  log "Mise à jour du compte admin en base (db:seed)…"
  if run_as_app "cd '$KOUZIA_APP_DIR' && npm run db:seed"; then
    ok "Admin prêt : $admin_email"
  else
    warn "Seed échoué. Vérifie les logs ; tu pourras relancer : kouziactl configure"
  fi
}

configure_public_site() {
  section "4/6  Site public kouzia.com" \
    "Seul site public. Il appelle l'API CRM (/api/public/*) pour le suivi client, devis, PDF…"

  local public_web client_portal site_url
  ask public_web "Origine du site (PUBLIC_WEB_ORIGIN, CORS)" "$(env_get PUBLIC_WEB_ORIGIN "https://kouzia.com")"
  ask client_portal "URL page suivi (CLIENT_PORTAL_URL, liens emails)" "$(env_get CLIENT_PORTAL_URL "https://kouzia.com/suivi")"
  ask site_url "URL redirections legacy SPA (VITE_PUBLIC_SITE_URL)" "$(env_get VITE_PUBLIC_SITE_URL "$public_web")"

  local old_vite
  old_vite="$(env_get VITE_PUBLIC_SITE_URL "")"
  env_set PUBLIC_WEB_ORIGIN "$public_web"
  env_set CLIENT_PORTAL_URL "$client_portal"
  env_set VITE_PUBLIC_SITE_URL "$site_url"
  if [[ "$site_url" != "$old_vite" ]]; then
    NEED_WEB_REBUILD=1
  fi
  ok "Site public enregistré"
}

configure_mail() {
  section "5/6  Email (SMTP / IMAP)" \
    "Optionnel : tu peux aussi tout renseigner plus tard dans Paramètres ERP. Laisser vide = skip."

  if ! yesno "Configurer SMTP / IMAP maintenant ?" "n"; then
    warn "Email skip."
    return 0
  fi

  local smtp_host smtp_port smtp_secure smtp_user smtp_pass smtp_from
  local imap_host imap_port imap_user imap_pass

  echo "  SMTP (envoi) :"
  ask smtp_host "SMTP_HOST" "$(env_get SMTP_HOST "")"
  ask smtp_port "SMTP_PORT" "$(env_get SMTP_PORT "465")"
  ask smtp_secure "SMTP_SECURE (true/false)" "$(env_get SMTP_SECURE "true")"
  ask smtp_user "SMTP_USER" "$(env_get SMTP_USER "")"
  ask_secret smtp_pass "SMTP_PASS" "$(env_get SMTP_PASS "")"
  ask smtp_from "SMTP_FROM" "$(env_get SMTP_FROM "KOUZIA <contact@kouzia.com>")"

  echo "  IMAP (réception, worker) :"
  ask imap_host "IMAP_HOST" "$(env_get IMAP_HOST "")"
  ask imap_port "IMAP_PORT" "$(env_get IMAP_PORT "993")"
  ask imap_user "IMAP_USER" "$(env_get IMAP_USER "")"
  ask_secret imap_pass "IMAP_PASS" "$(env_get IMAP_PASS "")"

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
  ok "Email enregistré"
}

configure_cloudflare() {
  local standalone="${1:-0}"
  section "Cloudflare Tunnel (pour exposer l'API à kouzia.com)" \
    "Zero Trust → Tunnels → hostname public → http://127.0.0.1:$(env_get API_PORT "$KOUZIA_API_PORT")"

  if [[ "$standalone" != "1" ]]; then
    if [[ "${PROFILE:-lan}" != "tunnel" ]]; then
      if ! yesno "Configurer un tunnel Cloudflare quand même ?" "n"; then
        warn "Tunnel skip. Backups / admin restent en LAN."
        return 0
      fi
    else
      if ! yesno "Configurer le token Cloudflare maintenant ?" "y"; then
        warn "Tunnel reporté. Relancer : kouziactl cloudflare"
        return 0
      fi
    fi
  fi

  local token
  ask_secret token "Token du tunnel (CLOUDFLARE_TUNNEL_TOKEN)" "$(env_get CLOUDFLARE_TUNNEL_TOKEN "")"
  [[ -n "$token" ]] || { warn "Token vide, skip."; return 0; }
  env_set CLOUDFLARE_TUNNEL_TOKEN "$token"
  env_set TRUST_PROXY "true"

  log "Installation cloudflared…"
  if ! command -v cloudflared >/dev/null 2>&1; then
    local arch url=""
    arch="$(uname -m)"
    case "$arch" in
      x86_64|amd64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
      aarch64|arm64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
      *) warn "Arch $arch non gérée pour cloudflared."; return 0 ;;
    esac
    curl -fsSL "$url" -o /usr/local/bin/cloudflared
    chmod 755 /usr/local/bin/cloudflared
  fi
  ok "cloudflared $(cloudflared --version 2>/dev/null | head -1 || echo OK)"

  install -m 755 "${SCRIPT_DIR}/openrc/cloudflared" /etc/init.d/cloudflared
  cat > /etc/conf.d/cloudflared <<EOF
CLOUDFLARE_TUNNEL_TOKEN="${token}"
EOF
  chmod 600 /etc/conf.d/cloudflared
  rc-update add cloudflared default 2>/dev/null || true
  rc-service cloudflared restart 2>/dev/null || rc-service cloudflared start
  ok "cloudflared démarré (vérifier status Healthy dans Cloudflare)"
}

configure_rsync() {
  section "6/6  Backup rsync offsite" \
    "Les backups locaux tournent déjà chaque jour dans $KOUZIA_BACKUP_DIR.
  Rsync = copie chiffrée vers un NAS / autre machine (recommandé)."

  mkdir -p "$KOUZIA_ETC_DIR"
  local current_target target ssh_cmd delete
  current_target="$(grep -E '^KOUZIA_RSYNC_TARGET=' "$KOUZIA_RSYNC_CONF" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"

  echo "  Exemple : backup@192.168.1.10:/volume1/backups/kouzia/"
  echo "  Laisser VIDE pour désactiver le rsync offsite (backups locaux seulement)."
  ask target "Cible rsync (user@host:/chemin/)" "${current_target}"

  if [[ -z "$target" ]]; then
    cat > "$KOUZIA_RSYNC_CONF" <<EOF
# Généré par configure.sh - $(date '+%Y-%m-%dT%H:%M:%S%z')
KOUZIA_RSYNC_TARGET=""
KOUZIA_RSYNC_SSH=""
KOUZIA_RSYNC_DELETE="0"
EOF
    chmod 600 "$KOUZIA_RSYNC_CONF"
    warn "Rsync offsite désactivé. Backups locaux : $KOUZIA_BACKUP_DIR"
    return 0
  fi

  ask ssh_cmd "Commande SSH custom (vide = ssh par défaut)" "$(grep -E '^KOUZIA_RSYNC_SSH=' "$KOUZIA_RSYNC_CONF" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  ask delete "Supprimer sur la cible les fichiers absents localement ? (0/1)" "0"

  cat > "$KOUZIA_RSYNC_CONF" <<EOF
# Généré par configure.sh - $(date '+%Y-%m-%dT%H:%M:%S%z')
KOUZIA_RSYNC_TARGET="${target}"
KOUZIA_RSYNC_SSH="${ssh_cmd}"
KOUZIA_RSYNC_DELETE="${delete}"
EOF
  chmod 600 "$KOUZIA_RSYNC_CONF"
  ok "Rsync → $target"

  if yesno "Lancer un backup + rsync de test maintenant ?" "y"; then
    bash "${SCRIPT_DIR}/backup.sh" || warn "Backup/rsync a échoué (SSH, droits, chemin ?)."
  fi
}

maybe_rebuild_web() {
  if [[ "$NEED_WEB_REBUILD" -eq 1 ]]; then
    log "VITE_PUBLIC_SITE_URL a changé : rebuild SPA…"
    run_as_app "cd '$KOUZIA_APP_DIR' && npm run build -w @kouziacrm/web" \
      || warn "Build SPA échoué (redirections legacy peuvent rester anciennes)."
  fi
}

restart_stack() {
  [[ "$SKIP_RESTART" -eq 1 ]] && return 0
  log "Redémarrage des services…"
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
[[ -f "$ENV_FILE" ]] || die ".env manquant: $ENV_FILE (lancer l'install d'abord)"

PROFILE="lan"
DO_RESTART=0

run_full_wizard() {
  echo ""
  echo "${C_BOLD}════════════════════════════════════════${C_RESET}"
  echo "${C_BOLD}  Assistant configuration KouziaCRM${C_RESET}"
  echo "${C_BOLD}════════════════════════════════════════${C_RESET}"
  print_access
  choose_profile
  configure_access
  configure_admin
  configure_public_site
  configure_mail
  configure_cloudflare 0
  configure_rsync
  maybe_rebuild_web
  restart_stack
  print_summary
  ok "Configuration terminée. Ouvre l'ERP avec l'URL LAN ci-dessus."
}

run_section() {
  echo ""
  echo "${C_BOLD}Configuration : ${SECTION}${C_RESET}"
  print_access
  case "$SECTION" in
    access)
      # Déduire un profil minimal pour COOKIE/TRUST defaults
      if [[ "$(env_get TRUST_PROXY "false")" == "true" ]] || [[ -n "$(env_get CLOUDFLARE_TUNNEL_TOKEN "")" ]]; then
        PROFILE="tunnel"
      else
        PROFILE="lan"
      fi
      configure_access
      DO_RESTART=1
      ;;
    admin)
      configure_admin
      DO_RESTART=1
      ;;
    site)
      configure_public_site
      maybe_rebuild_web
      DO_RESTART=1
      ;;
    mail)
      # Forcer la config mail (pas de yesno skip en mode section)
      section "Email (SMTP / IMAP)" \
        "Laisser un champ vide pour effacer / désactiver."
      local smtp_host smtp_port smtp_secure smtp_user smtp_pass smtp_from
      local imap_host imap_port imap_user imap_pass
      echo "  SMTP (envoi) :"
      ask smtp_host "SMTP_HOST" "$(env_get SMTP_HOST "")"
      ask smtp_port "SMTP_PORT" "$(env_get SMTP_PORT "465")"
      ask smtp_secure "SMTP_SECURE (true/false)" "$(env_get SMTP_SECURE "true")"
      ask smtp_user "SMTP_USER" "$(env_get SMTP_USER "")"
      ask_secret smtp_pass "SMTP_PASS" "$(env_get SMTP_PASS "")"
      ask smtp_from "SMTP_FROM" "$(env_get SMTP_FROM "KOUZIA <contact@kouzia.com>")"
      echo "  IMAP (réception, worker) :"
      ask imap_host "IMAP_HOST" "$(env_get IMAP_HOST "")"
      ask imap_port "IMAP_PORT" "$(env_get IMAP_PORT "993")"
      ask imap_user "IMAP_USER" "$(env_get IMAP_USER "")"
      ask_secret imap_pass "IMAP_PASS" "$(env_get IMAP_PASS "")"
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
      ok "Email enregistré"
      DO_RESTART=1
      ;;
    cloudflare)
      configure_cloudflare 1
      DO_RESTART=1
      ;;
    rsync)
      configure_rsync
      ;;
    *)
      die "Section inconnue: $SECTION"
      ;;
  esac

  if [[ "$DO_RESTART" -eq 1 ]]; then
    restart_stack
  fi
  print_summary
  ok "Section « ${SECTION} » terminée."
}

if [[ "$SECTION" == "all" ]]; then
  run_full_wizard
else
  run_section
fi
