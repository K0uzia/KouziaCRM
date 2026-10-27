#!/usr/bin/env bash
# Mise à jour incrémentale Kouzia ERP (Alpine) :
#  - verrou commun avec backup et restore, marqueur « mise à jour en cours »
#  - code et dépôt git rendus à root (le compte du service ne garde que data/, dépendances et SPA)
#  - arrêt app/worker, PUIS backup DB (obligatoire : un échec annule la mise à jour)
#  - git pull OU code déjà synchronisé (rsync depuis la machine de dev)
#  - npm ci seulement si package-lock.json a changé
#  - rebuild SPA seulement si le front / forms a changé
#  - prisma generate si schéma changé, migrate deploy toujours
#  - scripts OpenRC réinstallés s'ils ont changé, redémarrage + healthcheck
#  - échec après le changement de code : retour arrière proposé (code et backup d'avant)
#  - propose les nouvelles configs encore vides (voir conf/post-update-features)
#
# Usage :
#   kouziactl update
#   kouziactl update --git
#   kouziactl update --skip-backup    # sans backup, donc sans retour arrière possible
#   kouziactl update --force-deps     # force npm ci
#   kouziactl update --force-web      # force rebuild SPA
#   kouziactl update --no-system      # sans la mise à jour des paquets Alpine (apk upgrade)
#   kouziactl rollback [--yes]        # code et données d'avant la dernière mise à jour

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ORIG_ARGS=("$@")
DO_GIT=0
SKIP_BACKUP=0
FORCE_DEPS=0
FORCE_WEB=0
FORCE_ALL=0
GIT_EXPLICIT=0
SKIP_POST_UPDATE=0
RESUMED=0
NO_SYSTEM=0
ROLLBACK=0
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --git) DO_GIT=1; GIT_EXPLICIT=1; shift ;;
    --no-git) DO_GIT=0; GIT_EXPLICIT=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-config|--skip-post-update) SKIP_POST_UPDATE=1; shift ;;
    --force-deps) FORCE_DEPS=1; shift ;;
    --force-web) FORCE_WEB=1; shift ;;
    --force) FORCE_ALL=1; FORCE_DEPS=1; FORCE_WEB=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --yes) YES=1; shift ;;
    --resumed) RESUMED=1; shift ;;
    --no-system) NO_SYSTEM=1; shift ;;
    -h|--help)
      echo "Usage: update.sh [--git|--no-git] [--skip-backup] [--skip-config] [--force-deps] [--force-web] [--force] [--no-system]"
      echo "       update.sh --rollback [--yes]   (kouziactl rollback)"
      echo "  Défaut : git pull si $KOUZIA_APP_DIR/.git existe."
      echo "  Après update : propose les nouvelles configs (Tailscale, etc.) si encore vides."
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

# Transition : lancé par l'update.sh d'avant le durcissement, qui a déjà sauvegardé, arrêté la pile, tiré
# le code (rendu au compte du service) et relancé ce script avec KOUZIA_UPDATE_REEXEC=1 --no-git --skip-backup.
TRANSITION=0
if [[ -n "${KOUZIA_UPDATE_REEXEC:-}" && "$RESUMED" -eq 0 ]]; then
  TRANSITION=1
fi

require_root
ops_lock 0 "${SCRIPT_DIR}/update.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
trap 'exit 130' INT TERM
require_cmd curl sqlite3 npm npx

BRANCH="${KOUZIA_REPO_BRANCH:-main}"
MARKER="update-in-progress"
STACK_STOPPED=0
STACK_RESTARTED=0
# Phase relancée : la pile a été arrêtée par la première phase.
[[ "$RESUMED" -eq 1 ]] && STACK_STOPPED=1

on_exit() {
  local ec=$?
  if [[ $ec -ne 0 && "$STACK_STOPPED" -eq 1 && "$STACK_RESTARTED" -eq 0 ]]; then
    warn "Échec (code $ec) : redémarrage des services pour ne pas laisser l'app arrêtée…"
    service_safe kouziacrm start || true
    service_safe kouziacrm-worker start || true
  fi
  if [[ $ec -ne 0 && -f "${KOUZIA_STATE_DIR}/${MARKER}" ]]; then
    warn "Mise à jour inachevée : kouziactl rollback remet le code et les données d'avant ; kouziactl update la reprend."
  fi
}
trap on_exit EXIT

ask_yes() {
  local ans
  echo -n "  $1 [O/n]: "
  read -r ans || ans="n"
  [[ -z "$ans" || "$ans" =~ ^([oOyY]|oui|Oui|OUI)$ ]]
}

web_fingerprint() {
  tree_sha256 "$KOUZIA_APP_DIR" apps/web/src apps/web/index.html apps/web/vite.config.ts apps/web/package.json packages/kouzia-forms
}

save_fingerprints() {
  state_set "package-lock" "$(file_sha256 "${KOUZIA_APP_DIR}/package-lock.json")"
  state_set "prisma-schema" "$(file_sha256 "${KOUZIA_APP_DIR}/prisma/schema.prisma")"
  state_set "web" "$(web_fingerprint)"
}

# --- Retour arrière : code d'avant, dépendances et SPA reconstruites, backup d'avant remis ---
# Les fonctions viennent de la lib déjà chargée : le checkout d'un ancien commit ne les change pas.
do_rollback() {
  local prev bak ups
  prev="$(ops_state_get previous-commit)"
  bak="$(ops_state_get pre-update-backup)"
  [[ -n "$bak" && -f "$bak" ]] || die "Aucun backup d'avant mise à jour enregistré : retour arrière impossible (voir kouziactl restore)."
  ups="${bak%.db.gpg}.uploads.tar.gz.gpg"
  [[ -f "$ups" ]] || ups=""
  log "=== Retour à la version d'avant la mise à jour ==="
  if [[ -n "$prev" ]]; then
    echo "  Code    : $prev"
  else
    echo "  Code    : inchangé (aucun commit enregistré : mise à jour sans git)"
  fi
  echo "  Données : $bak"
  echo "  Ce qui a été saisi dans l'ERP depuis ce backup sera perdu (la base actuelle est gardée à côté)."
  if [[ "$YES" -ne 1 ]]; then
    [[ -t 0 ]] || die "Sans terminal : kouziactl rollback --yes"
    ask_yes "Revenir en arrière maintenant ?" || { echo "  Annulé."; exit 1; }
  fi
  ensure_ops_dirs
  stop_app_stack
  STACK_STOPPED=1
  if [[ -n "$prev" && -d "${KOUZIA_APP_DIR}/.git" ]]; then
    git_config_audit
    log "Code remis à ${prev}…"
    git_in_app checkout -f -B "$BRANCH" "$prev" || die "Impossible de remettre le code ${prev}."
    secure_app_tree
  fi
  ensure_app_dirs
  if [[ ! -x "${KOUZIA_APP_DIR}/node_modules/.bin/tsx" \
    || "$(file_sha256 "${KOUZIA_APP_DIR}/package-lock.json")" != "$(state_get package-lock)" ]]; then
    npm_ci_strict "$KOUZIA_APP_DIR" || die "npm ci a échoué pendant le retour arrière."
  fi
  run_as_app "cd '$KOUZIA_APP_DIR' && npx prisma generate" || die "prisma generate a échoué pendant le retour arrière."
  build_spa "$KOUZIA_APP_DIR" || die "Le build SPA a échoué pendant le retour arrière."
  install_kouziactl_link "${KOUZIA_APP_DIR}/scripts/alpine/kouziactl" /usr/local/bin/kouziactl
  install_app_openrc "${KOUZIA_APP_DIR}/scripts/alpine/openrc"
  install_tunnel_openrc "${KOUZIA_APP_DIR}/scripts/alpine/openrc"
  restore_backup "$bak" "$ups" || die "L'API ne répond toujours pas après le retour arrière : kouziactl logs app."
  STACK_RESTARTED=1
  save_fingerprints
  ops_state_clear previous-commit pre-update-backup "$MARKER"
  ok "Retour arrière terminé : code $(git_in_app rev-parse --short HEAD 2>/dev/null || echo 'inchangé'), données de $(basename "$bak")."
}

# Échec après le changement de code : retour arrière proposé, sinon la marche à suivre.
fail_update() {
  warn "$1"
  tail -n 40 "${KOUZIA_LOG_DIR}/app.log" 2>/dev/null || true
  tail -n 20 "${KOUZIA_LOG_DIR}/app.err" 2>/dev/null || true
  if [[ -t 0 && -n "$(ops_state_get pre-update-backup)" ]]; then
    echo ""
    if ask_yes "Revenir à la version d'avant (code et données d'avant la mise à jour) ?"; then
      YES=1
      do_rollback
      exit 1
    fi
  fi
  echo "  Plus tard : kouziactl rollback remet la version d'avant ; kouziactl logs app montre l'erreur."
  exit 1
}

if [[ "$ROLLBACK" -eq 1 ]]; then
  do_rollback
  exit 0
fi

if [[ "$RESUMED" -eq 0 ]]; then
  # Avant le backup, l'arrêt, le git pull et npm ci : rien ne change si Node est trop ancien.
  require_node_min
  disk_guard "$KOUZIA_APP_DIR" 400
  [[ -f "${KOUZIA_APP_DIR}/package.json" ]] || die "App introuvable dans $KOUZIA_APP_DIR (lancer install.sh d'abord)."

  log "=== Kouzia ERP : mise à jour ==="
  if [[ "$TRANSITION" -eq 1 ]]; then
    log "Mode : transition (code tiré par l'ancien update.sh), reprise des droits"
  elif [[ "$DO_GIT" -eq 1 ]]; then
    log "Mode : git pull + incrémental"
  else
    log "Mode : incrémental local (pas de git pull)"
  fi

  # --- 1. Arrêt AVANT les droits et le backup : aucun processus du compte du service pendant la reprise
  # des droits, rien n'est écrit entre la copie et la mise à jour ---
  stop_app_stack
  STACK_STOPPED=1

  # --- 2. Droits : code à root, data/ et dépendances au compte du service, état des opérations à root ---
  ensure_ops_dirs
  log "Droits : code et .git à root, data/ et dépendances à ${KOUZIA_USER}…"
  secure_app_tree
  ensure_app_dirs
  migrate_legacy_state

  if [[ -d "${KOUZIA_APP_DIR}/.git" ]]; then
    git_config_audit
  fi
  if [[ "$TRANSITION" -eq 1 ]]; then
    # Le code a été tiré quand le compte du service possédait .git : contrôle avant de s'en servir en root.
    log "Contrôle du dépôt (objets git et fichiers suivis identiques au commit)…"
    git_in_app fsck --no-dangling --no-progress >/dev/null || die "git fsck en échec : dépôt à vérifier avant toute mise à jour."
    git_in_app diff --quiet --no-ext-diff --no-textconv HEAD -- \
      || die "Fichiers suivis différents du commit $(git_in_app rev-parse --short HEAD) : git -C $KOUZIA_APP_DIR status, puis relancer."
  fi

  # --- 3. Point de retour arrière (gardé tel quel si une mise à jour précédente s'est interrompue) ---
  if [[ -f "${KOUZIA_STATE_DIR}/${MARKER}" ]]; then
    warn "Une mise à jour précédente s'est interrompue ($(ops_state_get "$MARKER")) : reprise."
    warn "Le point de retour arrière d'origine est gardé (kouziactl rollback)."
  else
    # Un backup d'une mise à jour plus ancienne ne doit jamais servir de retour arrière à celle-ci.
    ops_state_clear pre-update-backup previous-commit
    PREV=""
    if [[ -d "${KOUZIA_APP_DIR}/.git" ]] && [[ "$DO_GIT" -eq 1 || "$TRANSITION" -eq 1 ]]; then
      if [[ "$TRANSITION" -eq 1 ]]; then
        # Commit d'avant le pull de l'ancien script : valeur précédente de la branche (son reflog). Pas
        # HEAD@{1} : checkout -B sur la branche courante écrit deux entrées dans le reflog de HEAD.
        PREV="$(git_in_app rev-parse -q --verify "refs/heads/${BRANCH}@{1}^{commit}" || git_in_app rev-parse HEAD)"
      else
        PREV="$(git_in_app rev-parse HEAD)"
      fi
    fi
    # L'ancien script a imposé --skip-backup à la transition : backup refait ici, app arrêtée.
    if [[ "$SKIP_BACKUP" -eq 0 || "$TRANSITION" -eq 1 ]]; then
      if [[ -f "$KOUZIA_DB_PATH" ]]; then
        log "Backup pré-update (app arrêtée)…"
        BAK="$(bash "${SCRIPT_DIR}/backup.sh" --tag "pre-update" --skip-rsync)" \
          || die "Backup pré-update échoué : mise à jour arrêtée avant toute migration (kouziactl logs backup)."
        ops_state_set pre-update-backup "$BAK"
        ok "Backup : $BAK"
      else
        warn "Pas encore de DB, skip backup."
      fi
    else
      warn "--skip-backup : aucun retour arrière possible pour cette mise à jour."
    fi
    [[ -z "$PREV" ]] || ops_state_set previous-commit "$PREV"
    ops_state_set "$MARKER" "$(date '+%Y-%m-%dT%H:%M:%S%z') depuis ${PREV:-code local}"
  fi

  # --- 4. Code ---
  if [[ "$DO_GIT" -eq 1 && "$TRANSITION" -eq 0 ]]; then
    [[ -d "${KOUZIA_APP_DIR}/.git" ]] || die "--git demandé mais pas de dépôt git dans $KOUZIA_APP_DIR"
    log "git pull…"
    # Le dépôt GitHub fait foi pour le verrou npm.
    git_in_app checkout HEAD -- package-lock.json 2>/dev/null || true
    git_sync_from_origin "$BRANCH"
  fi
  if [[ "$DO_GIT" -eq 1 || "$TRANSITION" -eq 1 ]]; then
    # Ce shell a chargé update.sh et lib.sh d'avant le pull : la suite tourne sur les nouveaux (à root).
    log "Relance de la mise à jour avec les scripts à jour…"
    FWD=(--resumed --no-git)
    [[ "$FORCE_ALL" -eq 1 ]] && FWD+=(--force)
    [[ "$FORCE_DEPS" -eq 1 ]] && FWD+=(--force-deps)
    [[ "$FORCE_WEB" -eq 1 ]] && FWD+=(--force-web)
    [[ "$SKIP_POST_UPDATE" -eq 1 ]] && FWD+=(--skip-config)
    [[ "$NO_SYSTEM" -eq 1 ]] && FWD+=(--no-system)
    trap - EXIT
    unset KOUZIA_UPDATE_REEXEC
    exec bash "${SCRIPT_DIR}/update.sh" "${FWD[@]}"
  fi
  log "Pas de git pull (code déjà en place ou poussé via rsync). Utiliser --git si besoin."
fi

ensure_app_dirs

# --- 4 bis. Paquets Alpine (correctifs de sécurité de la branche installée), pile arrêtée et sauvegarde faite ---
if [[ "$NO_SYSTEM" -eq 0 ]]; then
  system_upgrade
else
  warn "--no-system : paquets Alpine non mis à jour."
fi
node_security_report

# --- 5. Détection changements ---
log "Calcul des empreintes…"
NEW_LOCK="$(file_sha256 "${KOUZIA_APP_DIR}/package-lock.json")"
OLD_LOCK="$(state_get package-lock)"
NEW_SCHEMA="$(file_sha256 "${KOUZIA_APP_DIR}/prisma/schema.prisma")"
OLD_SCHEMA="$(state_get prisma-schema)"
NEW_WEB="$(web_fingerprint)"
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

# --- 6. Dépendances, base, SPA ---
if [[ "$NEED_DEPS" -eq 1 ]]; then
  npm_ci_strict "$KOUZIA_APP_DIR" || fail_update "npm ci a échoué."
else
  ok "package-lock inchangé : skip npm ci"
fi

if [[ "$NEED_PRISMA_GEN" -eq 1 ]]; then
  log "prisma generate…"
  run_as_app "cd '$KOUZIA_APP_DIR' && npx prisma generate" || fail_update "prisma generate a échoué."
else
  ok "schéma Prisma inchangé : skip generate"
fi

log "prisma migrate deploy…"
prisma_migrate_deploy "$KOUZIA_APP_DIR" || fail_update "Les migrations de la base ont échoué."

# Reprise des anciennes données : comptes à blanc d'abord, puis exécution réelle seulement si cette mise à jour a
# sa sauvegarde (retour arrière possible). Idempotente : rien à reprendre, comptes à zéro.
log "Reprise des données…"
run_reprise --dry-run || fail_update "Comptes à blanc de la reprise impossibles."
if [[ -n "$(ops_state_get pre-update-backup)" ]]; then
  run_reprise || fail_update "La reprise des données a échoué."
else
  warn "Aucune sauvegarde pour cette mise à jour : reprise réelle non lancée."
  warn "Après une sauvegarde : kouziactl backup, puis kouziactl reprise."
fi

if [[ "$NEED_WEB" -eq 1 ]]; then
  build_spa "$KOUZIA_APP_DIR" || fail_update "Le build SPA a échoué."
else
  ok "front inchangé : skip build SPA"
fi

# Secret des liens d'invitation : obligatoire en production (l'API refuse de démarrer sans). Absent ou
# encore à une valeur d'exemple « change-me… » : généré comme à l'installation, jamais une vraie valeur remplacée.
ENV_PATH="${KOUZIA_APP_DIR}/.env"
if [[ -f "$ENV_PATH" ]]; then
  hmac_current="$(grep -E '^ONBOARDING_HMAC_SECRET=' "$ENV_PATH" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d '[:space:]' || true)"
  if [[ -z "$hmac_current" ]] || [[ "${hmac_current,,}" == change-me* ]]; then
    sed -i '/^ONBOARDING_HMAC_SECRET=/d' "$ENV_PATH"
    printf 'ONBOARDING_HMAC_SECRET="%s"\n' "$(openssl rand -hex 32)" >> "$ENV_PATH"
    env_fix_perms
    ok "ONBOARDING_HMAC_SECRET absent du .env : généré (les liens d'invitation déjà envoyés sont à renvoyer)."
  fi
fi
# Mot de passe admin de départ et jeton du tunnel : hors du .env (décision du 27/10/2026), une fois.
migrate_env_secrets

# --- 7. Scripts système, restart + health ---
install_kouziactl_link "${KOUZIA_APP_DIR}/scripts/alpine/kouziactl" /usr/local/bin/kouziactl
# Pile déjà arrêtée (étape 2) par les scripts en place : les nouveaux sont copiés avant le démarrage.
install_app_openrc "${KOUZIA_APP_DIR}/scripts/alpine/openrc"
install_tunnel_openrc "${KOUZIA_APP_DIR}/scripts/alpine/openrc"
install_system_conf
# Avant le démarrage : Node lit les données ICU à son lancement.
ensure_icu_full

log "Redémarrage services…"
# Worker après health : évite le lock SQLite pendant le boot API (tsx + migrations soft).
service_safe kouziacrm-worker stop
service_safe kouziacrm start
sleep 2
if ! wait_health; then
  fail_update "Mise à jour terminée mais API unhealthy."
fi
STACK_RESTARTED=1
service_safe kouziacrm-worker start
ok "Worker démarré après health OK"

# Tunnel actif sans hôte admin : erp.kouzia.com répondrait 404 sur toute l'admin.
_env_val() { grep -E "^$1=" "${KOUZIA_APP_DIR}/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
_trust="$(_env_val TRUST_PROXY)"
if [[ "${_trust,,}" != "false" && "$_trust" != "0" && -z "$(_env_val ADMIN_PUBLIC_ORIGIN)" ]]; then
  warn "ADMIN_PUBLIC_ORIGIN absent du .env : admin injoignable par le tunnel (erp.kouzia.com en 404)."
  warn "Ajouter ADMIN_PUBLIC_ORIGIN=\"https://erp.kouzia.com\" dans ${KOUZIA_APP_DIR}/.env puis : kouziactl restart"
fi

# --- 8. Persister empreintes, fin du marqueur (le point de retour arrière reste pour kouziactl rollback) ---
save_fingerprints
ops_state_set last-update "$(date '+%Y-%m-%dT%H:%M:%S%z')"
ops_state_clear "$MARKER"

ok "Mise à jour terminée."
echo "  DB : $KOUZIA_DB_PATH"
echo "  Status : kouziactl status"
echo "  UI : hard refresh navigateur (Ctrl+Shift+R) si cache"
echo "  En cas de souci plus tard : kouziactl rollback remet la version d'avant."

# --- 9. Nouvelles configs (Tailscale, etc.) ---
if [[ "$SKIP_POST_UPDATE" -eq 0 ]]; then
  log "Nouveautés de configuration…"
  bash "${SCRIPT_DIR}/configure.sh" --post-update \
    || warn "Config post-update ignorée. Relancer : kouziactl new-config"
fi
