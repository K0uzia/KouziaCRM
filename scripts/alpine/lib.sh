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
# Opérations lancées par root (mise à jour, sauvegarde, restauration) : état, journal et verrou dans des
# dossiers de root, jamais dans un dossier du compte du service (piège par lien symbolique sur > et tee -a).
KOUZIA_STATE_DIR="${KOUZIA_STATE_DIR:-/var/lib/kouzia-ops}"
KOUZIA_OPS_LOG_DIR="${KOUZIA_OPS_LOG_DIR:-/var/log/kouzia-ops}"
KOUZIA_OPS_LOCK="${KOUZIA_OPS_LOCK:-/run/kouzia-ops.lock}"
# Journaux des services (app, worker, tunnel) : dossier à root, fichiers au compte de chaque service.
KOUZIA_LOG_DIR="${KOUZIA_LOG_DIR:-/var/log/kouzia}"
KOUZIA_ETC_DIR="${KOUZIA_ETC_DIR:-/etc/kouzia}"
KOUZIA_PASSPHRASE_FILE="${KOUZIA_PASSPHRASE_FILE:-${KOUZIA_ETC_DIR}/backup-pass}"
KOUZIA_RSYNC_CONF="${KOUZIA_RSYNC_CONF:-${KOUZIA_ETC_DIR}/rsync.env}"
KOUZIA_RETENTION_DAYS="${KOUZIA_RETENTION_DAYS:-30}"
KOUZIA_API_PORT="${KOUZIA_API_PORT:-3000}"
KOUZIA_HEALTH_URL="${KOUZIA_HEALTH_URL:-http://127.0.0.1:${KOUZIA_API_PORT}/api/health}"

# Alpine = musl. npm 11 / detect-libc se trompent parfois en LXC et installent
# des .node glibc (rollup, lightningcss, oxide) → Bus error au `vite build`.
if [[ -f /etc/alpine-release ]]; then
  export npm_config_libc=musl
fi

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

# Version minimale de Node (notifications push : @block65/webcrypto-web-push, Node >= 22).
KOUZIA_NODE_MIN=22

# Arrêt propre, AVANT toute modification (git pull, npm ci, arrêt des services), si Node est trop ancien :
# une mise à jour ne doit jamais rester à moitié déployée.
require_node_min() {
  local min="${1:-$KOUZIA_NODE_MIN}" major
  major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "$major" -lt "$min" ]]; then
    echo "${C_RED}ERREUR${C_RESET} Node.js $min ou plus requis (installé : $(node -v 2>/dev/null || echo aucun)). Rien n'a été modifié." >&2
    echo "  Alpine : apk add --no-cache nodejs-current npm   (ou passer le CT en Alpine 3.21 ou plus, Node 22)" >&2
    echo "  Vérifier : node -v   puis relancer : kouziactl update" >&2
    exit 1
  fi
}

# Versions corrigées de la CVE-2026-111497 (décodeur Brotli, correctifs Node.js du 21/10/2026) : 22.23.4, 24.22.1,
# 26.12.1. Branches 23 et 25, et 20 ou plus ancienne : plus corrigées.
KOUZIA_NODE_PATCHED="22.23.4, 24.22.1 ou 26.12.1"

# État de sécurité du Node installé : ok | vulnerable | eol (branche sans correctif) | absent.
node_security_state() {
  command -v node >/dev/null 2>&1 || { echo absent; return 0; }
  node -e '
const [a, b, c] = process.versions.node.split(".").map(Number);
const fixed = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
if (a > 26) { console.log("ok"); process.exit(0); }
const f = fixed[a];
if (!f) { console.log("eol"); process.exit(0); }
console.log(b > f[0] || (b === f[0] && c >= f[1]) ? "ok" : "vulnerable");
' 2>/dev/null || echo absent
}

# Ligne « Node » de kouziactl status : en rouge si le Node installé n'est pas corrigé.
node_security_line() {
  local state version
  state="$(node_security_state)"
  version="$(node -v 2>/dev/null || echo absent)"
  case "$state" in
    ok) echo "  Node     : ${version} ${C_GREEN}(corrigé, CVE-2026-111497)${C_RESET}" ;;
    vulnerable) echo "  Node     : ${C_RED}${version} VULNÉRABLE (CVE-2026-111497, Brotli) : ${KOUZIA_NODE_PATCHED} au moins, kouziactl update${C_RESET}" ;;
    eol) echo "  Node     : ${C_RED}${version} SANS CORRECTIF (branche plus maintenue) : passer à ${KOUZIA_NODE_PATCHED}${C_RESET}" ;;
    *) echo "  Node     : ${C_RED}absent${C_RESET}" ;;
  esac
}

# Mise à jour de sécurité de Node par apk (nodejs ou nodejs-current, celui qui est installé). Ne bloque jamais :
# si Alpine ne fournit pas encore la version corrigée, le service continue et la marche à suivre est affichée.
node_security_upgrade() {
  local state pkg
  state="$(node_security_state)"
  [[ "$state" == "ok" ]] && { ok "Node $(node -v) corrigé (CVE-2026-111497)"; return 0; }
  if [[ -f /etc/alpine-release ]] && command -v apk >/dev/null 2>&1; then
    pkg=nodejs
    apk info -e nodejs-current >/dev/null 2>&1 && pkg=nodejs-current
    log "Node $(node -v 2>/dev/null || echo absent) non corrigé (CVE-2026-111497) : apk upgrade ${pkg}…"
    apk update >/dev/null 2>&1 || true
    apk upgrade --no-cache "$pkg" npm || warn "apk upgrade ${pkg} a échoué."
    state="$(node_security_state)"
  fi
  if [[ "$state" == "ok" ]]; then
    ok "Node $(node -v) corrigé (CVE-2026-111497). Les services prennent la nouvelle version à leur redémarrage."
    return 0
  fi
  warn "Node $(node -v 2>/dev/null || echo absent) reste non corrigé (CVE-2026-111497, décodeur Brotli) : il faut ${KOUZIA_NODE_PATCHED} au moins."
  warn "  Le service continue de tourner. Alpine ne fournit sans doute pas encore la version corrigée pour cette branche."
  warn "  À faire : apk update && apk upgrade nodejs (ou nodejs-current) dès sa publication (pkgs.alpinelinux.org, paquet nodejs),"
  warn "  ou passer le CT à une branche Alpine plus récente ; vérifier ensuite avec : kouziactl status"
  return 0
}

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
  local prefix=""
  [[ -f /etc/alpine-release ]] && prefix="export npm_config_libc=musl; "
  if [[ "$(id -u)" -eq 0 ]]; then
    su -s /bin/bash "$KOUZIA_USER" -c "${prefix}$*"
  else
    bash -c "${prefix}$*"
  fi
}

# Commande sous le compte du service, arguments transmis tels quels (jamais réinterprétés par un shell).
# Toute lecture ou écriture dans data/ passe par là : root n'y ouvre aucun chemin que ce compte contrôle.
run_as_app_argv() {
  local cmd
  printf -v cmd '%q ' "$@"
  if [[ "$(id -u)" -eq 0 ]]; then
    su -s /bin/bash "$KOUZIA_USER" -c "$cmd"
  else
    bash -c "$cmd"
  fi
}

# git en root, sur un dépôt possédé par root (secure_app_tree) : ni safe.directory, ni hooks, ni fsmonitor.
# git-scm.com/docs/git, section SECURITY : la config et les hooks d'un dépôt peuvent lancer des commandes.
git_in_app() {
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$KOUZIA_APP_DIR" "$@"
}

# Clés admises dans .git/config : celles qu'écrivent git clone, git fetch et un réglage courant. Toute autre
# clé (alias, filtre, pager, sshCommand, include, diff externe...) peut lancer une commande en root : refusée.
git_config_key_allowed() {
  [[ "$1" =~ ^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch|tagopt|prune)|branch\.[A-Za-z0-9._/-]+\.(remote|merge|rebase)|pull\.(rebase|ff)|fetch\.prune|gc\.auto|user\.(name|email)|extensions\.objectformat)$ ]]
}

git_remote_url_allowed() {
  [[ "$1" =~ ^(https://|ssh://|git@)[A-Za-z0-9._~:/@%+-]+$ ]]
}

# Contrôle de .git/config avant tout git lancé par root (lecture seule, sans include).
git_config_audit() {
  local dir="${KOUZIA_APP_DIR}/.git" keys urls key url bad=()
  [[ -d "$dir" && ! -L "$dir" ]] || die "Dépôt git absent ou lien symbolique : $dir"
  [[ -f "${dir}/config" && ! -L "${dir}/config" ]] || die "Fichier ${dir}/config absent ou lien symbolique."
  [[ ! -e "${dir}/config.worktree" ]] || bad+=("config.worktree")
  keys="$(git config --file "${dir}/config" --no-includes --name-only --list)" \
    || die "Lecture de ${dir}/config impossible."
  while IFS= read -r key; do
    [[ -z "$key" ]] || git_config_key_allowed "$key" || bad+=("$key")
  done <<< "$keys"
  urls="$(git config --file "${dir}/config" --no-includes --get-all remote.origin.url || true)"
  while IFS= read -r url; do
    [[ -z "$url" ]] || git_remote_url_allowed "$url" || bad+=("remote.origin.url=${url}")
  done <<< "$urls"
  [[ ${#bad[@]} -eq 0 ]] && return 0
  echo "${C_RED}ERREUR${C_RESET} Réglages inattendus dans ${dir}/config : git n'est pas lancé en root." >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "  Les retirer (git config --file ${dir}/config --unset <clé>) puis relancer." >&2
  exit 1
}

# Aligne le code du CT sur GitHub (source de vérité).
# Un `git pull --ff-only` casse dès qu'il y a force-push, clone shallow, ou
# un commit local (lockfile npm). Ici : fetch + reset dur. Conservé : .env, data/.
git_sync_from_origin() {
  local branch="${1:-main}"
  [[ -d "${KOUZIA_APP_DIR}/.git" ]] || die "Pas de dépôt git dans $KOUZIA_APP_DIR"
  git_config_audit

  log "Synchronisation git → origin/${branch} (reset, GitHub fait foi)…"
  git_in_app fetch --depth 1 origin "+${branch}:refs/remotes/origin/${branch}" \
    || die "git fetch origin/${branch} échoué."

  # -B : crée ou repositionne UNIQUEMENT $branch sur origin/$branch, puis s'y place.
  # Pas de reset FETCH_HEAD sur HEAD courant (risque de bouger une autre branche).
  git_in_app checkout -f -B "$branch" "origin/${branch}" \
    || git_in_app checkout -f -B "$branch" FETCH_HEAD \
    || die "Impossible de placer ${branch} sur origin/${branch}."

  # Code tiré en root : il reste à root (jamais rendu au compte du service, root l'exécute).
  secure_app_tree

  ok "HEAD = $(git_in_app rev-parse --short HEAD) (origin/${branch})"
}

# SPA production : Vite seul. tsc -b casse si node_modules partiel (types react-router).
build_spa() {
  local dir="${1:-$KOUZIA_APP_DIR}"
  log "Build SPA (vite)…"
  run_as_app "cd '$dir' && npm run build:spa -w @kouzia-erp/web"
}

# Dossiers de root des opérations. Les journaux des services gardent leur dossier (à root, voir openrc/).
ensure_ops_dirs() {
  mkdir -p "$KOUZIA_BACKUP_DIR" "$KOUZIA_ETC_DIR" "$KOUZIA_STATE_DIR" "$KOUZIA_OPS_LOG_DIR" "$KOUZIA_LOG_DIR"
  chown root:root "$KOUZIA_BACKUP_DIR" "$KOUZIA_ETC_DIR" "$KOUZIA_STATE_DIR" "$KOUZIA_OPS_LOG_DIR" "$KOUZIA_LOG_DIR"
  chmod 750 "$KOUZIA_ETC_DIR" "$KOUZIA_BACKUP_DIR" "$KOUZIA_OPS_LOG_DIR"
  chmod 700 "$KOUZIA_STATE_DIR"
  chmod 755 "$KOUZIA_LOG_DIR"
}

ensure_dirs() {
  mkdir -p "$KOUZIA_APP_DIR"
  chown root:root "$KOUZIA_APP_DIR"
  chmod 755 "$KOUZIA_APP_DIR"
  ensure_ops_dirs
}

# Chemins (relatifs au dossier de l'app) possédés par le compte du service : données, dépendances et SPA,
# écrites par npm, prisma generate et vite lancés sous ce compte, et dossiers de npm (son HOME est le
# dossier de l'app). Root n'exécute rien de ces dossiers et n'y écrit pas.
ops_app_paths() {
  local app="${1:-$KOUZIA_APP_DIR}" d
  printf '%s\n' data node_modules apps/web/dist .npm .cache .config
  for d in "$app"/apps/*/ "$app"/packages/*/; do
    d="${d%/}"
    [[ -d "$d" && ! -L "$d" ]] || continue
    printf '%s\n' "${d#"${app}"/}/node_modules"
  done
}

# Entrées de premier niveau rendues à root : tout sauf .env (traité à part) et les chemins ci-dessus.
ops_code_entries() {
  local app="${1:-$KOUZIA_APP_DIR}" e
  for e in "$app"/* "$app"/.[!.]* "$app"/..?*; do
    [[ -e "$e" || -L "$e" ]] || continue
    case "${e##*/}" in
      .env|data|node_modules|.npm|.cache|.config) continue ;;
    esac
    printf '%s\n' "$e"
  done
}

# Code et dépôt git à root:root (dossiers 755, fichiers 644, exécutables 755) : root exécute ces scripts
# (cron de sauvegarde, kouziactl, update.sh). Sans effet sur les chemins de ops_app_paths.
# KOUZIA_OPS_DRY_RUN=1 : affiche les commandes au lieu de les lancer (tests sans root).
secure_app_tree() {
  local app="$KOUZIA_APP_DIR" e pre=()
  [[ "${KOUZIA_OPS_DRY_RUN:-0}" == "1" ]] && pre=(echo)
  [[ -d "$app" && ! -L "$app" ]] || die "Dossier de l'app introuvable ou lien symbolique : $app"
  local prune=( \( -path "${app}/apps/*/node_modules" -o -path "${app}/packages/*/node_modules" -o -path "${app}/apps/web/dist" \) -prune -o )
  "${pre[@]}" chown root:root "$app"
  "${pre[@]}" chmod 755 "$app"
  while IFS= read -r e; do
    [[ ! -L "$e" ]] || die "Lien symbolique inattendu dans le dossier de l'app : $e (le retirer puis relancer)."
    # Dossiers un par un, parent avant enfants : un dossier déjà à root ne peut plus voir une entrée
    # remplacée par un lien symbolique pendant la suite. Ensuite seulement, fichiers et droits en lot.
    find "$e" "${prune[@]}" -type d -exec "${pre[@]}" chown -h root:root {} \;
    find "$e" "${prune[@]}" -exec "${pre[@]}" chown -h root:root {} +
    find "$e" "${prune[@]}" ! -type l -exec "${pre[@]}" chmod u=rwX,go=rX {} +
  done < <(ops_code_entries "$app")
  env_fix_perms
}

# .env : écrit par root seulement, lu par le service, les scripts npm et prisma (compte du service).
env_fix_perms() {
  local env="${KOUZIA_APP_DIR}/.env" pre=()
  [[ "${KOUZIA_OPS_DRY_RUN:-0}" == "1" ]] && pre=(echo)
  [[ -e "$env" || -L "$env" ]] || return 0
  [[ ! -L "$env" ]] || die "$env est un lien symbolique : le remplacer par le fichier lui-même puis relancer."
  "${pre[@]}" chown "root:${KOUZIA_GROUP}" "$env"
  "${pre[@]}" chmod 640 "$env"
}

# Crée les chemins du compte du service (sous des parents à root) et les lui donne, sans récursion.
ensure_app_dirs() {
  local app="$KOUZIA_APP_DIR" rel p pre=()
  [[ "${KOUZIA_OPS_DRY_RUN:-0}" == "1" ]] && pre=(echo)
  while IFS= read -r rel; do
    p="${app}/${rel}"
    if [[ -L "$p" ]]; then
      # Lien posé par l'administrateur (à root) : cible laissée telle quelle. Sinon, posé par le compte du service.
      [[ "$(stat -c %u "$p")" == "0" ]] || die "Lien symbolique inattendu : $p (le retirer puis relancer)."
      continue
    fi
    "${pre[@]}" mkdir -p "$p"
    "${pre[@]}" chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "$p"
  done < <(ops_app_paths "$app")
  [[ -L "${app}/data" ]] || "${pre[@]}" chmod 750 "${app}/data"
  "${pre[@]}" chmod 700 "${app}/.npm" "${app}/.cache" "${app}/.config"
  "${pre[@]}" run_as_app_argv mkdir -p "${app}/data/uploads/obligations"
  # Fichiers laissés à root dans data/ par les anciennes versions (sqlite3 et restauration lancés en root).
  if [[ -d "${app}/data" && ! -L "${app}/data" ]]; then
    find "${app}/data" -user 0 -exec "${pre[@]}" chown -h "${KOUZIA_USER}:${KOUZIA_GROUP}" {} +
  fi
}

# Valeur d'état reprise de l'ancien dossier .deploy-state : format attendu seulement.
legacy_state_value_ok() {
  case "$1" in
    package-lock.sha|prisma-schema.sha|web.sha) [[ "$2" =~ ^([0-9a-f]{64}|missing|empty|error)$ ]] ;;
    last-update) [[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{4}$ ]] ;;
    features-offered) [[ -n "$2" ]] && ! grep -qvE '^[a-z0-9_-]+$' <<< "$2" ;;
    *) return 1 ;;
  esac
}

# Ancien état (dossier de l'app, au compte du service) vers KOUZIA_STATE_DIR (root). Appelé après
# secure_app_tree, qui a rendu l'ancien dossier à root : son contenu ne peut plus changer pendant la copie.
migrate_legacy_state() {
  local old="${KOUZIA_APP_DIR}/.deploy-state" name val
  [[ -d "$old" && ! -L "$old" ]] || return 0
  [[ "$(stat -c %u "$old")" == "0" ]] || die "$old n'appartient pas encore à root (secure_app_tree d'abord)."
  mkdir -p "$KOUZIA_STATE_DIR"
  chmod 700 "$KOUZIA_STATE_DIR"
  for name in package-lock.sha prisma-schema.sha web.sha last-update features-offered; do
    [[ -f "${old}/${name}" && ! -L "${old}/${name}" && ! -e "${KOUZIA_STATE_DIR}/${name}" ]] || continue
    val="$(head -c 4096 "${old}/${name}")"
    if legacy_state_value_ok "$name" "$val"; then
      printf '%s\n' "$val" > "${KOUZIA_STATE_DIR}/${name}"
    else
      warn "État ignoré (contenu inattendu) : ${old}/${name}"
    fi
  done
  rm -rf "$old"
  ok "État des opérations déplacé : ${old} → ${KOUZIA_STATE_DIR}"
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

# État des opérations (dossier de root) : empreintes, dernière mise à jour, point de retour arrière.
ops_state_get() {
  local f="${KOUZIA_STATE_DIR}/$1"
  if [[ -f "$f" ]]; then cat "$f"; fi
}

ops_state_set() {
  mkdir -p "$KOUZIA_STATE_DIR"
  chmod 700 "$KOUZIA_STATE_DIR"
  printf '%s\n' "$2" > "${KOUZIA_STATE_DIR}/$1"
}

ops_state_clear() {
  local name
  for name in "$@"; do
    rm -f "${KOUZIA_STATE_DIR}/${name}"
  done
}

state_get() {
  ops_state_get "$1.sha"
}

state_set() {
  ops_state_set "$1.sha" "$2"
}

# Verrou commun à update, backup et restore (man7.org flock(1)). Le script se relance sous
# « flock -o » : le verrou reste tenu par flock, jamais transmis aux processus lancés (services,
# gpg-agent), qui le garderaient après la fin du script. Les scripts appelés dessous en héritent.
# ops_lock <attente en s, 0 = aucune> <script> [arguments...]
ops_lock() {
  local wait="$1" rc=0 mode=(-n)
  shift
  [[ "${KOUZIA_OPS_LOCK_HELD:-0}" == "1" ]] && return 0
  ensure_flock
  [[ "$wait" -gt 0 ]] && mode=(-w "$wait")
  KOUZIA_OPS_LOCK_HELD=1 flock "${mode[@]}" -o -E 75 "$KOUZIA_OPS_LOCK" bash "$@" || rc=$?
  [[ "$rc" -ne 75 ]] || die "Une autre opération (mise à jour, sauvegarde ou restauration) est en cours : attendre sa fin puis relancer."
  exit "$rc"
}

# flock d'util-linux (options -o et -E) : celui de BusyBox ne les a pas.
ensure_flock() {
  [[ "$(flock --version 2>&1 || true)" == *util-linux* ]] && return 0
  if [[ -f /etc/alpine-release ]]; then
    log "Installation de flock (util-linux)…" >&2
    apk add --no-cache flock >/dev/null 2>&1 || apk add --no-cache util-linux >/dev/null 2>&1 || true
    hash -r
  fi
  [[ "$(flock --version 2>&1 || true)" == *util-linux* ]] || die "flock d'util-linux requis : apk add flock"
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

# Avant de remplacer la base : plus aucun superviseur ni processus de l'app (sqlite.org/howtocorrupt.html).
assert_app_stopped() {
  local svc pids
  for svc in kouziacrm kouziacrm-worker; do
    [[ -z "$(supervisor_pid "$svc")" ]] || die "Superviseur de ${svc} encore actif : base non remplacée (kouziactl stop, puis relancer)."
  done
  pids="$(app_process_pids "tsx.*(apps/api/src/index\\.ts|scripts/worker\\.ts)")"
  [[ -z "$pids" ]] || die "Processus de l'app encore actifs ($(echo "$pids" | tr '\n' ' ')) : base non remplacée."
}

# Déchiffre une sauvegarde vers un fichier écrit par le compte du service (dossier à lui ou data/).
decrypt_to_app() {
  local src="$1" dest="$2"
  gpg --batch --yes --decrypt --passphrase-file "$KOUZIA_PASSPHRASE_FILE" --output - "$src" \
    | run_as_app_argv sh -c 'umask 077; cat > "$1"' sh "$dest"
}

# PRAGMA integrity_check lancé par le compte du service (root n'ouvre pas une base venue de data/).
check_db_as_app() {
  local out
  out="$(run_as_app_argv sqlite3 "$1" "PRAGMA integrity_check;" 2>&1 || true)"
  [[ "$out" == "ok" ]] && return 0
  warn "integrity_check : ${out}"
  return 1
}

# Remet une sauvegarde chiffrée (base, et pièces jointes si fournies), puis démarre l'app et contrôle sa
# santé (retour 1 si elle ne répond pas). Base contrôlée avant l'arrêt ; base actuelle déplacée avec ses
# fichiers -wal et -shm, jamais supprimée ; écritures dans data/ faites par le compte du service.
restore_backup() {
  local db_gpg="$1" up_gpg="${2:-}" stamp stage keep rc=0
  stamp="$(date +%Y%m%d%H%M%S)"
  stage="${KOUZIA_DATA_DIR}/.restauration-${stamp}.db"
  keep="${KOUZIA_DB_PATH}.avant-restauration-${stamp}"
  run_as_app_argv mkdir -p "$KOUZIA_DATA_DIR"
  log "Déchiffrement et contrôle de la base…"
  decrypt_to_app "$db_gpg" "$stage" || { run_as_app_argv rm -f "$stage"; die "Déchiffrement impossible : $db_gpg"; }
  check_db_as_app "$stage" || { run_as_app_argv rm -f "$stage"; die "Base de la sauvegarde abîmée : rien n'a été remplacé."; }
  ok "Intégrité OK"

  stop_app_stack
  assert_app_stopped
  # Base, -wal, -shm et -journal déplacés ensemble : séparés, SQLite rejouerait un journal sur la mauvaise base.
  run_as_app_argv sh -c '
    set -eu
    for s in "" -wal -shm -journal; do
      if [ -e "$1$s" ] || [ -L "$1$s" ]; then mv -f "$1$s" "$3$s"; fi
    done
    mv -f "$2" "$1"
    chmod 600 "$1"
  ' sh "$KOUZIA_DB_PATH" "$stage" "$keep"
  ok "Base restaurée : $KOUZIA_DB_PATH (base d'avant, s'il y en avait une : ${keep}, avec ses -wal et -shm)"

  if [[ -n "$up_gpg" ]]; then
    log "Pièces jointes…"
    gpg --batch --yes --decrypt --passphrase-file "$KOUZIA_PASSPHRASE_FILE" --output - "$up_gpg" \
      | run_as_app_argv tar -C "$KOUZIA_DATA_DIR" -xzf - \
      && ok "Uploads restaurés" \
      || { warn "Restauration des pièces jointes échouée ($up_gpg) : la base est remise, relancer avec --uploads."; rc=1; }
  fi

  # Sauvegarde plus ancienne que le code : ses migrations manquantes sont appliquées.
  prisma_migrate_deploy "$KOUZIA_APP_DIR" || rc=1
  log "Redémarrage…"
  service_safe kouziacrm start
  sleep 2
  if ! wait_health; then
    warn "API unhealthy après restauration : kouziactl logs app"
    return 1
  fi
  service_safe kouziacrm-worker start
  return "$rc"
}

# Scripts OpenRC de l'app (API, worker) : (ré)installés quand ils diffèrent de ceux du dépôt.
# Transition : la pile est arrêtée par les scripts EN PLACE (leur pidfile, leur superviseur)
# avant la copie, sinon un processus lancé par l'ancien script resterait orphelin.
install_app_openrc() {
  local src_dir="$1" svc changed=()
  for svc in kouziacrm kouziacrm-worker; do
    cmp -s "${src_dir}/${svc}" "/etc/init.d/${svc}" || changed+=("$svc")
  done
  if [[ ${#changed[@]} -eq 0 ]]; then
    ok "Scripts OpenRC inchangés"
    return 0
  fi
  if service_exists kouziacrm || service_exists kouziacrm-worker; then
    stop_app_stack
  fi
  for svc in "${changed[@]}"; do
    install -m 755 "${src_dir}/${svc}" "/etc/init.d/${svc}"
    # pidfile de start-stop-daemon (anciens scripts) : supervise-daemon tient le sien.
    rm -f "/run/${svc}.pid"
    ok "Script OpenRC installé : /etc/init.d/${svc}"
  done
}

# Tunnel : script réinstallé s'il a changé, seulement s'il est déjà posé (kouziactl cloudflare le pose).
# Arrêt par le script en place (pidfile de start-stop-daemon), relance par le nouveau s'il tournait.
# /etc/conf.d/cloudflared n'a pas à changer : même variable CLOUDFLARE_TOKEN_FILE, et l'ancien format
# (CLOUDFLARE_TUNNEL_TOKEN dans conf.d) reste lu par le nouveau script.
install_tunnel_openrc() {
  local src="$1/cloudflared" dst=/etc/init.d/cloudflared was_running=0
  [[ -f "$src" && -f "$dst" ]] || return 0
  cmp -s "$src" "$dst" && return 0
  rc-service cloudflared status >/dev/null 2>&1 && was_running=1
  rc-service cloudflared stop >/dev/null 2>&1 || true
  install -m 755 "$src" "$dst"
  rm -f /run/cloudflared.pid
  ok "Script OpenRC installé : $dst (jeton par l'environnement, compte nobody, supervise-daemon)"
  if [[ "$was_running" -eq 1 ]]; then
    rc-service cloudflared start \
      || warn "cloudflared ne démarre pas : tail ${KOUZIA_LOG_DIR}/cloudflared.err, puis kouziactl cloudflare"
  fi
}

# Fichiers système posés par install et update : rotation des journaux et sauvegarde quotidienne.
# Données de langue ICU complètes : le Node d'Alpine utilise l'ICU du système, livré par défaut avec
# icu-data-en seul (en_US, en_GB). Sans icu-data-full, Intl en fr-FR retombe sur l'anglais (« €1,190.00 »).
# Idempotent ; un échec (réseau) prévient sans bloquer : les documents de l'ERP n'en dépendent plus.
ensure_icu_full() {
  command -v apk >/dev/null 2>&1 || return 0
  apk info -e icu-data-full >/dev/null 2>&1 && return 0
  log "Données de langue complètes (icu-data-full)…"
  apk add --no-cache icu-data-full >/dev/null 2>&1 \
    || warn "apk add icu-data-full a échoué : kouziactl status signalera « intl incomplet » ; relancer plus tard."
}

install_system_conf() {
  install -m 644 "${KOUZIA_APP_DIR}/scripts/alpine/conf/logrotate.kouzia" /etc/logrotate.d/kouzia
  cat > /etc/periodic/daily/kouzia-backup <<EOF
#!/bin/sh
# Backup quotidien Kouzia ERP (Alpine busybox crond : /etc/periodic/daily). Journal : ${KOUZIA_OPS_LOG_DIR}/backup.log
exec /bin/bash ${KOUZIA_APP_DIR}/scripts/alpine/backup.sh
EOF
  chmod 755 /etc/periodic/daily/kouzia-backup
}

# Service OpenRC et script lancé, pour app | worker.
app_service_name() {
  case "$1" in
    app) echo kouziacrm ;;
    worker) echo kouziacrm-worker ;;
    *) die "Cible inconnue : $1 (app | worker)" ;;
  esac
}
app_service_script() {
  case "$1" in
    app) echo 'apps/api/src/index\.ts' ;;
    worker) echo 'scripts/worker\.ts' ;;
  esac
}

# PID de supervise-daemon pour un service. Jamais par motif sur « tsx…worker.ts » : la ligne de
# commande du superviseur contient aussi ces arguments (et son PID est le plus petit).
supervisor_pid() {
  local svc="$1" pid
  pid="$(cat "/run/supervise-${svc}.pid" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    pid="$(pgrep -f "^supervise-daemon ${svc} " 2>/dev/null | head -1 || true)"
  fi
  [[ "$pid" =~ ^[0-9]+$ ]] && echo "$pid"
  return 0
}

# Processus de l'app (tsx et node) hors superviseurs : orphelins une fois le superviseur parti.
app_process_pids() {
  local pattern="$1" pid
  for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
    [[ "$pid" == "$$" ]] && continue
    [[ "$(cat "/proc/${pid}/comm" 2>/dev/null)" == "supervise-daemon" ]] && continue
    echo "$pid"
  done
}

# Remise en état d'un service dont le superviseur a disparu (état « unsupervised ») :
# état OpenRC remis à zéro, processus orphelins arrêtés, démarrage supervisé.
repair_app_service() {
  local target="$1" svc pattern pids i
  svc="$(app_service_name "$target")"
  pattern="$(app_service_script "$target")"
  log "Remise en état de ${svc}…"
  rc-service "$svc" stop >/dev/null 2>&1 || true
  rc-service "$svc" zap
  pids="$(app_process_pids "$pattern")"
  if [[ -n "$pids" ]]; then
    warn "Processus orphelins : $(echo "$pids" | tr '\n' ' ')→ arrêt"
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    for ((i = 1; i <= 10; i++)); do
      [[ -z "$(app_process_pids "$pattern")" ]] && break
      sleep 1
    done
    pids="$(app_process_pids "$pattern")"
    # shellcheck disable=SC2086
    [[ -n "$pids" ]] && kill -KILL $pids 2>/dev/null || true
  fi
  rc-service "$svc" start
  [[ "$target" == "app" ]] && { wait_health || warn "API unhealthy après remise en état"; }
  rc-service "$svc" status || true
}

# Recette de relance : tue le processus node du service (le petit-enfant du superviseur, jamais
# le superviseur), puis vérifie qu'un nouveau processus est lancé par le MÊME superviseur.
selftest_respawn() {
  local target="$1" svc sup child leaf new i
  svc="$(app_service_name "$target")"
  rc-service "$svc" status >/dev/null 2>&1 || die "${svc} n'est pas démarré (kouziactl status)."
  sup="$(supervisor_pid "$svc")"
  [[ -n "$sup" ]] || die "Superviseur de ${svc} introuvable : état non supervisé, lancer kouziactl repair-service ${target}."
  child="$(pgrep -P "$sup" 2>/dev/null | head -1 || true)"
  [[ -n "$child" ]] || die "Aucun processus sous le superviseur ${sup}."
  leaf="$(pgrep -P "$child" 2>/dev/null | head -1 || true)"
  leaf="${leaf:-$child}"
  log "Superviseur ${sup}, tsx ${child}, processus visé ${leaf} ($(tr '\0' ' ' < "/proc/${leaf}/cmdline" 2>/dev/null | cut -c1-80))"
  kill -KILL "$leaf"
  ok "kill -9 ${leaf} envoyé, attente de la relance (respawn_delay 5 s)…"
  for ((i = 1; i <= 30; i++)); do
    sleep 1
    kill -0 "$sup" 2>/dev/null || die "Le superviseur ${sup} a disparu : recette en échec."
    new="$(pgrep -P "$sup" 2>/dev/null | head -1 || true)"
    if [[ -n "$new" && "$new" != "$child" ]]; then
      ok "Relancé en ${i} s par le même superviseur ${sup} : nouveau processus ${new}"
      [[ "$target" == "app" ]] && { wait_health || die "Relancé mais API unhealthy."; }
      rc-service "$svc" status || true
      return 0
    fi
  done
  die "Pas de relance en 30 s : voir kouziactl logs ${target} et /var/log/kouzia/*.err"
}

# Reprise des anciennes données (scripts/reprise.ts) : sortie en nombres seulement. Exécution réelle : ses comptes
# sont ajoutés au journal reprise.log (date et nombres, aucune donnée personnelle). Usage : run_reprise [--dry-run]
run_reprise() {
  local out
  if [[ "${1:-}" == "--dry-run" ]]; then
    out="$(run_as_app "cd '$KOUZIA_APP_DIR' && npm run --silent reprise -- --dry-run")" || { printf '%s\n' "$out"; return 1; }
    printf '%s\n' "$out"
    return 0
  fi
  out="$(run_as_app "cd '$KOUZIA_APP_DIR' && npm run --silent reprise")" || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out"
  mkdir -p "$KOUZIA_OPS_LOG_DIR"
  { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')]"; printf '%s\n' "$out"; } >> "${KOUZIA_OPS_LOG_DIR}/reprise.log"
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
  warn "prisma migrate deploy a échoué (SQLite locked ou erreur migration)."
  return 1
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

# npm ci strict, sans repli npm install : celui-ci réécrirait package-lock.json, que GitHub fixe.
# --include=dev : vite/typescript indispensables au build SPA, même si NODE_ENV=production.
npm_ci_strict() {
  local dir="${1:-$KOUZIA_APP_DIR}"
  log "npm ci dans $dir…"
  local libc_args=()
  [[ -f /etc/alpine-release ]] && libc_args=(--libc=musl)
  if ! run_as_app "cd '$dir' && node scripts/check-lockfile.mjs"; then
    warn "Lockfile élagué (souvent un npm install sous Windows) : npm ci risque d'échouer, à corriger dans le dépôt."
  fi
  if run_as_app "cd '$dir' && npm ci --include=dev ${libc_args[*]}"; then
    ok "npm ci terminé"
    return 0
  fi
  warn "npm ci a échoué (lockfile ou plateforme) : corriger package-lock.json dans le dépôt, sans npm install sur le CT."
  return 1
}

# Lignes que kouziactl push-keys peut ajouter au .env (le reste est refusé) : vides, commentaires, clés VAPID.
push_keys_lines_ok() {
  local line
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=\"[A-Za-z0-9_:@./+%-]*\"$ ]] || return 1
  done <<< "$1"
}
