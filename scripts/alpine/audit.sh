#!/usr/bin/env bash
# Accès d'audit en lecture seule (décision d'Alexandre du 28/10/2026) : une clé SSH dédiée ne peut lancer que le
# rapport, sans donnée personnelle des clients ni secret (audit-lib.mjs).
#
#   kouziactl audit report [--json|--text]   rapport sur ce CT (root ou compte du service)
#   kouziactl audit on <clé-publique.pub>     ouvre l'accès à cette clé (root)
#   kouziactl audit off                       coupe l'accès tout de suite (root)
#   kouziactl audit status                    ouvert ou fermé, depuis quand, derniers rapports (root)
#
# Chaîne d'un rapport à distance :
#   sshd (clé « restrict,command=… ») → compte kouzia-audit, sans droit sur l'ERP
#   → sudo, une seule règle : ce script, « run text » ou « run json », sans autre argument
#   → root : contrôle que l'accès est ouvert, note la date et l'IP dans le journal d'audit
#   → compte du service (su) : node audit-report.mjs, base ouverte en lecture seule.
# Pourquoi sudo plutôt qu'une lecture de groupe sur la base : kouzia-audit n'a aucun droit de lecture sur les données ;
# même sorti de la commande forcée, il ne pourrait lancer que ce rapport filtré. Le journal, écrit par root, ne peut
# pas être effacé par ce compte. Le rapport tourne sous le compte du service, jamais sous root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

KOUZIA_AUDIT_USER="${KOUZIA_AUDIT_USER:-kouzia-audit}"
KOUZIA_AUDIT_HOME="${KOUZIA_AUDIT_HOME:-/var/lib/kouzia-audit}"
KOUZIA_AUDIT_SUDOERS="${KOUZIA_AUDIT_SUDOERS:-/etc/sudoers.d/kouzia-audit}"
KOUZIA_AUDIT_LOG="${KOUZIA_AUDIT_LOG:-${KOUZIA_OPS_LOG_DIR}/audit-access.log}"
AUDIT_SELF="${KOUZIA_APP_DIR}/scripts/alpine/audit.sh"
AUDIT_FORCED_COMMAND="/usr/local/bin/kouziactl audit report --via-ssh"

audit_usage() {
  cat <<EOF
Usage :
  kouziactl audit report [--json|--text]   rapport en lecture seule (sans donnée client ni secret)
  kouziactl audit on <clé-publique.pub>     ouvre l'accès SSH du rapport à cette clé ed25519 (root)
  kouziactl audit off                       coupe l'accès (root)
  kouziactl audit status                    état de l'accès et derniers rapports (root)
EOF
}

# IP source de la connexion SSH (premier champ de SSH_CONNECTION, posé par sshd), ou « locale ».
audit_source_ip() {
  local ip="${SSH_CONNECTION%% *}"
  if [[ -z "${SSH_CONNECTION:-}" ]]; then echo "locale"
  elif [[ "$ip" =~ ^[0-9A-Fa-f:.]{3,45}$ ]]; then echo "$ip"
  else echo "inconnue"
  fi
}

audit_log() {
  mkdir -p "$KOUZIA_OPS_LOG_DIR"
  chmod 750 "$KOUZIA_OPS_LOG_DIR" 2>/dev/null || true
  [[ ! -L "$KOUZIA_AUDIT_LOG" ]] || die "$KOUZIA_AUDIT_LOG est un lien symbolique : refusé."
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$KOUZIA_AUDIT_LOG"
  chmod 640 "$KOUZIA_AUDIT_LOG" 2>/dev/null || true
}

audit_keys_file() {
  local home
  home="$(getent passwd "$KOUZIA_AUDIT_USER" 2>/dev/null | cut -d: -f6 || true)"
  echo "${home:-$KOUZIA_AUDIT_HOME}/.ssh/authorized_keys"
}

# Lance le rapport. Root : sous le compte du service, chemins du CT. Sinon (poste de dev) : sous le compte courant,
# base trouvée par le .env du dépôt.
audit_run_report() {
  local fmt="$1"
  require_cmd node
  local node_args=(node --disable-warning=ExperimentalWarning "${SCRIPT_DIR}/audit-report.mjs" "--${fmt}")
  if [[ "$(id -u)" -eq 0 ]]; then
    node_args+=(--app-dir "$KOUZIA_APP_DIR" --db "$KOUZIA_DB_PATH" --log-dir "$KOUZIA_LOG_DIR")
    if command -v timeout >/dev/null 2>&1; then node_args=(timeout 120 "${node_args[@]}"); fi
    run_as_app_argv "${node_args[@]}"
  else
    "${node_args[@]}" --app-dir "$(cd "${SCRIPT_DIR}/../.." && pwd)"
  fi
}

cmd_report() {
  local fmt="text" via_ssh=0 a
  for a in "$@"; do
    case "$a" in
      --json) fmt="json" ;;
      --text) fmt="text" ;;
      --via-ssh) via_ssh=1 ;;
      *) die "Usage : kouziactl audit report [--json|--text]" ;;
    esac
  done
  if [[ "$via_ssh" -eq 1 ]]; then
    # Commande forcée de la clé : le client choisit seulement le format, rien d'autre n'est accepté.
    case "${SSH_ORIGINAL_COMMAND:-}" in
      ""|report|"report --text"|text) fmt="text" ;;
      "report --json"|json) fmt="json" ;;
      *) echo "Commande refusée. Seules sont admises : report, report --json" >&2; exit 2 ;;
    esac
    exec sudo -n "$AUDIT_SELF" run "$fmt"
  fi
  audit_run_report "$fmt"
}

# Appelé par sudo depuis la commande forcée (ou par root) : contrôle, journal, puis rapport.
cmd_run() {
  require_root
  [[ $# -eq 1 && ( "$1" == "text" || "$1" == "json" ) ]] || die "Usage interne : audit.sh run text|json"
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "$KOUZIA_AUDIT_USER" ]]; then die "Refusé."; fi
  local ip
  ip="$(audit_source_ip)"
  if [[ "$(ops_state_get audit-enabled)" != "1" ]]; then
    audit_log "refus ip=${ip} motif=acces-ferme"
    die "Accès d'audit fermé."
  fi
  audit_log "rapport ip=${ip} format=$1"
  audit_run_report "$1"
}

audit_key_fingerprint() {
  local f="$1"
  if command -v ssh-keygen >/dev/null 2>&1; then
    ssh-keygen -lf "$f" 2>/dev/null | awk '{print $2}'
  fi
}

cmd_on() {
  require_root
  [[ $# -eq 1 ]] || die "Usage : kouziactl audit on <clé-publique.pub>"
  local src="$1" line type b64 tmp fp home keys sshdir
  [[ -f "$src" && ! -L "$src" ]] || die "Fichier introuvable : $src"
  [[ "$(grep -cvE '^[[:space:]]*(#|$)' "$src")" -eq 1 ]] || die "Le fichier doit contenir une seule clé publique."
  line="$(grep -vE '^[[:space:]]*(#|$)' "$src" | tr -d '\r')"
  # Clé ed25519 seule, sans option : les options sont posées ici, jamais reprises du fichier.
  local re='^(ssh-ed25519)[[:space:]]+([A-Za-z0-9+/]{60,80}={0,2})([[:space:]].*)?$'
  [[ "$line" =~ $re ]] || die "Clé publique ed25519 attendue (ligne « ssh-ed25519 AAAA… »), rien d'autre."
  type="${BASH_REMATCH[1]}"
  b64="${BASH_REMATCH[2]}"

  command -v sshd >/dev/null 2>&1 || die "OpenSSH (sshd) absent. L'installer d'abord : apk add openssh && rc-update add sshd && rc-service sshd start"
  if ! command -v sudo >/dev/null 2>&1; then
    log "Installation de sudo (règle unique pour le rapport d'audit)…"
    apk add --no-cache sudo >/dev/null || die "apk add sudo a échoué."
  fi
  command -v visudo >/dev/null 2>&1 || die "visudo introuvable (paquet sudo incomplet)."
  grep -Eq '^[[:space:]]*[@#]includedir[[:space:]]+/etc/sudoers\.d' /etc/sudoers \
    || die "/etc/sudoers ne lit pas /etc/sudoers.d : ajouter la ligne « @includedir /etc/sudoers.d » (visudo), puis relancer."

  # Compte système dédié : pas de mot de passe (« * » : ni connexion par mot de passe, ni compte verrouillé pour sshd).
  getent group "$KOUZIA_AUDIT_USER" >/dev/null 2>&1 || addgroup -S "$KOUZIA_AUDIT_USER"
  if ! id "$KOUZIA_AUDIT_USER" >/dev/null 2>&1; then
    adduser -S -D -H -h "$KOUZIA_AUDIT_HOME" -s /bin/sh -G "$KOUZIA_AUDIT_USER" "$KOUZIA_AUDIT_USER"
  fi
  echo "${KOUZIA_AUDIT_USER}:*" | chpasswd -e >/dev/null 2>&1 || warn "chpasswd -e a échoué : vérifier que le compte n'est pas verrouillé (/etc/shadow)."
  if id -nG "$KOUZIA_AUDIT_USER" | tr ' ' '\n' | grep -qxE "${KOUZIA_GROUP}|root|wheel|adm"; then
    die "Le compte $KOUZIA_AUDIT_USER appartient à un groupe privilégié : le retirer de ce groupe, puis relancer."
  fi

  # Dossier et clés à root : le compte ne peut ni changer sa clé ni en ajouter une sans restriction.
  home="$(getent passwd "$KOUZIA_AUDIT_USER" | cut -d: -f6)"
  [[ -n "$home" && "$home" == /* ]] || die "Dossier du compte $KOUZIA_AUDIT_USER introuvable."
  sshdir="${home}/.ssh"
  keys="${sshdir}/authorized_keys"
  mkdir -p "$sshdir"
  chown root:root "$home" "$sshdir"
  chmod 755 "$home" "$sshdir"
  tmp="$(mktemp "${sshdir}/.ak.XXXXXX")"
  printf 'restrict,command="%s" %s %s kouzia-audit\n' "$AUDIT_FORCED_COMMAND" "$type" "$b64" > "$tmp"
  chown root:root "$tmp"
  chmod 644 "$tmp"
  fp="$(audit_key_fingerprint "$tmp")"
  mv -f "$tmp" "$keys"

  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# Posé par kouziactl audit on : le compte ${KOUZIA_AUDIT_USER} ne peut lancer que le rapport d'audit en lecture seule.
Defaults:${KOUZIA_AUDIT_USER} env_reset, env_keep += "SSH_CONNECTION", !requiretty, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
${KOUZIA_AUDIT_USER} ALL=(root) NOPASSWD: ${AUDIT_SELF} run text, ${AUDIT_SELF} run json
EOF
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "Règle sudo refusée par visudo : rien n'est ouvert."; }
  install -o root -g root -m 440 "$tmp" "$KOUZIA_AUDIT_SUDOERS"
  rm -f "$tmp"

  ops_state_set audit-enabled 1
  ops_state_set audit-since "$(date '+%Y-%m-%d %H:%M')"
  ops_state_set audit-key-fp "${fp:-inconnue}"
  audit_log "ouverture cle=${fp:-inconnue} par=$(audit_source_ip)"
  ok "Accès d'audit ouvert pour la clé ${fp:-(empreinte indisponible)}."
  audit_sshd_checks
  echo "  Depuis le PC : ssh -i ~/.ssh/kouzia-audit ${KOUZIA_AUDIT_USER}@<adresse du CT> report"
  echo "  Couper : kouziactl audit off"
}

# Réglages sshd qui empêcheraient la connexion : signalés, jamais modifiés.
audit_sshd_checks() {
  local conf
  conf="$(sshd -T -C "user=${KOUZIA_AUDIT_USER},host=localhost,addr=127.0.0.1" 2>/dev/null || true)"
  if [[ -z "$conf" ]]; then
    warn "Configuration sshd illisible (sshd -T) : vérifier à la main que la connexion par clé est permise."
    return 0
  fi
  grep -qi '^pubkeyauthentication yes' <<<"$conf" || warn "sshd : PubkeyAuthentication n'est pas à yes."
  if grep -qi '^allowusers ' <<<"$conf" && ! grep -qiE "^allowusers .*\b${KOUZIA_AUDIT_USER}\b" <<<"$conf"; then
    warn "sshd : AllowUsers ne contient pas ${KOUZIA_AUDIT_USER} : l'ajouter dans /etc/ssh/sshd_config puis rc-service sshd reload."
  fi
  if grep -qi '^allowgroups ' <<<"$conf"; then
    warn "sshd : AllowGroups est posé : y ajouter ${KOUZIA_AUDIT_USER} si besoin."
  fi
  grep -qi '^authorizedkeysfile .*\.ssh/authorized_keys' <<<"$conf" \
    || warn "sshd : AuthorizedKeysFile ne lit pas .ssh/authorized_keys."
  if command -v rc-service >/dev/null 2>&1 && ! rc-service sshd status >/dev/null 2>&1; then
    warn "Le service sshd ne tourne pas : rc-update add sshd && rc-service sshd start"
  fi
}

cmd_off() {
  require_root
  local keys
  keys="$(audit_keys_file)"
  rm -f "$keys" "$KOUZIA_AUDIT_SUDOERS"
  # Sessions en cours du compte coupées tout de suite.
  if id "$KOUZIA_AUDIT_USER" >/dev/null 2>&1; then
    pkill -KILL -u "$(id -u "$KOUZIA_AUDIT_USER")" >/dev/null 2>&1 || true
  fi
  ops_state_set audit-enabled 0
  ops_state_set audit-since "$(date '+%Y-%m-%d %H:%M')"
  audit_log "fermeture par=$(audit_source_ip)"
  ok "Accès d'audit fermé : clé retirée, règle sudo retirée, sessions coupées."
}

cmd_status() {
  require_root
  local enabled since fp keys
  enabled="$(ops_state_get audit-enabled)"
  since="$(ops_state_get audit-since)"
  fp="$(ops_state_get audit-key-fp)"
  keys="$(audit_keys_file)"
  if [[ "$enabled" == "1" ]]; then
    echo "Accès d'audit : ${C_GREEN}ouvert${C_RESET} depuis ${since:-?} (clé ${fp:-?})"
    [[ -s "$keys" ]] || warn "État ouvert mais aucune clé en place (${keys}) : kouziactl audit on <clé.pub> ou audit off."
    [[ -f "$KOUZIA_AUDIT_SUDOERS" ]] || warn "Règle sudo absente (${KOUZIA_AUDIT_SUDOERS}) : le rapport à distance échouera."
  else
    echo "Accès d'audit : fermé${since:+ depuis ${since}}"
    [[ ! -s "$keys" ]] || warn "Une clé reste en place (${keys}) : kouziactl audit off pour la retirer."
  fi
  if [[ -f "$KOUZIA_AUDIT_LOG" ]]; then
    echo "Derniers événements (${KOUZIA_AUDIT_LOG}) :"
    tail -n 10 "$KOUZIA_AUDIT_LOG" | sed 's/^/  /'
  fi
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  report) cmd_report "$@" ;;
  run) cmd_run "$@" ;;
  on) cmd_on "$@" ;;
  off) [[ $# -eq 0 ]] || die "Usage : kouziactl audit off"; cmd_off ;;
  status) cmd_status ;;
  help|-h|--help) audit_usage ;;
  *) audit_usage; exit 1 ;;
esac
