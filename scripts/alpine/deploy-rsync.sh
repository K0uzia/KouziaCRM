#!/usr/bin/env bash
# Depuis votre machine de dev : pousse le code vers le CT Alpine via rsync,
# puis lance update incrémental (sans rebuild inutile).
#
# Usage :
#   ./scripts/alpine/deploy-rsync.sh user@ct-ip
#   ./scripts/alpine/deploy-rsync.sh --host user@ct --git-on-remote
#   KOUZIA_REMOTE=root@10.0.0.50 ./scripts/alpine/deploy-rsync.sh
#
# Prérequis locaux : rsync, ssh
# Prérequis CT : installation déjà faite (install.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXCLUDE_FILE="${SCRIPT_DIR}/conf/rsync-exclude.txt"

REMOTE="${KOUZIA_REMOTE:-}"
REMOTE_DIR="${KOUZIA_REMOTE_DIR:-/opt/kouziacrm}"
SSH_OPTS="${KOUZIA_SSH_OPTS:-}"
RUN_GIT_ON_REMOTE=0
SKIP_UPDATE=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [user@host] [options]

Options:
  --host user@host     Cible SSH (sinon 1er argument ou KOUZIA_REMOTE)
  --dir PATH           Chemin distant (défaut: $REMOTE_DIR)
  --git-on-remote      Sur le CT: git pull au lieu de pousser le code local
  --skip-update        Rsync seul, sans lancer update.sh
  --dry-run            Simulation rsync
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) REMOTE="$2"; shift 2 ;;
    --dir) REMOTE_DIR="$2"; shift 2 ;;
    --git-on-remote) RUN_GIT_ON_REMOTE=1; shift ;;
    --skip-update) SKIP_UPDATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Option inconnue: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$REMOTE" ]]; then
        REMOTE="$1"
      else
        echo "Argument inattendu: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

[[ -n "$REMOTE" ]] || { usage; echo "Erreur: hôte manquant (user@ct)." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync requis localement." >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh requis localement." >&2; exit 1; }

RSYNC_FLAGS=(-az --delete --human-readable --info=stats2)
[[ "$DRY_RUN" -eq 1 ]] && RSYNC_FLAGS+=(--dry-run)
SSH_CMD=(ssh)
# shellcheck disable=SC2206
[[ -n "$SSH_OPTS" ]] && SSH_CMD+=($SSH_OPTS)

echo "==> Déploiement KouziaCRM → ${REMOTE}:${REMOTE_DIR}"

if [[ "$RUN_GIT_ON_REMOTE" -eq 1 ]]; then
  echo "==> Mode git sur le CT (pas de rsync code)"
else
  echo "==> rsync code (excl. node_modules, data, .env, …)"
  rsync "${RSYNC_FLAGS[@]}" \
    -e "${SSH_CMD[*]}" \
    --exclude-from="$EXCLUDE_FILE" \
    "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run terminé."
  exit 0
fi

if [[ "$SKIP_UPDATE" -eq 1 ]]; then
  echo "Skip update distant."
  exit 0
fi

UPDATE_ARGS=()
[[ "$RUN_GIT_ON_REMOTE" -eq 1 ]] && UPDATE_ARGS+=(--git)

echo "==> update incrémental sur le CT…"
# shellcheck disable=SC2029
"${SSH_CMD[@]}" "$REMOTE" "KOUZIA_APP_DIR='${REMOTE_DIR}' bash '${REMOTE_DIR}/scripts/alpine/update.sh' ${UPDATE_ARGS[*]:-}"

echo ""
echo "OK. Vérifier : ssh $REMOTE kouziactl status"
