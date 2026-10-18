#!/usr/bin/env bash
# Restauration d'un backup GPG Kouzia ERP.
#
# Usage :
#   kouziactl restore /var/backup/kouzia/kouziacrm-2026-09-03.db.gpg
#   kouziactl restore /var/backup/kouzia/kouziacrm-….db.gpg --uploads /var/backup/kouzia/kouziacrm-….uploads.tar.gz.gpg
#   kouziactl restore --check /var/backup/kouzia/kouziacrm-….db.gpg [--uploads …]   contrôle seul, rien n'est modifié
# Option : --yes (sans question).
#
# Étapes : contrôle (déchiffrement, intégrité), arrêt de l'app vérifié, base actuelle déplacée à côté avec
# ses -wal et -shm (jamais supprimée), base remise, migrations, redémarrage, healthcheck.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

ORIG_ARGS=("$@")
RESTORE_UPLOADS=""
BACKUP_FILE=""
CHECK_ONLY=0
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uploads) RESTORE_UPLOADS="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help)
      echo "Usage: restore.sh [--check] [--yes] <fichier.db.gpg> [--uploads fichier.uploads.tar.gz.gpg]"
      exit 0
      ;;
    -*) die "Option inconnue: $1" ;;
    *)
      if [[ -z "$BACKUP_FILE" ]]; then
        BACKUP_FILE="$1"
        shift
      else
        die "Argument inattendu: $1"
      fi
      ;;
  esac
done

[[ -n "$BACKUP_FILE" ]] || die "Fichier backup requis. Exemple: kouziactl restore /var/backup/kouzia/kouziacrm-DATE.db.gpg"
[[ -f "$BACKUP_FILE" ]] || die "Fichier introuvable: $BACKUP_FILE"
[[ -z "$RESTORE_UPLOADS" || -f "$RESTORE_UPLOADS" ]] || die "Uploads introuvables: $RESTORE_UPLOADS"
[[ -f "$KOUZIA_PASSPHRASE_FILE" ]] || die "Passphrase absente: $KOUZIA_PASSPHRASE_FILE"
require_root
ops_lock 0 "${SCRIPT_DIR}/restore.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
umask 077
trap 'exit 130' INT TERM
require_cmd gpg sqlite3 tar

# --- Contrôle, dans un dossier temporaire du compte du service ---
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
chown "${KOUZIA_USER}:${KOUZIA_GROUP}" "$CHECK_DIR"
log "Contrôle de $(basename "$BACKUP_FILE")…"
decrypt_to_app "$BACKUP_FILE" "${CHECK_DIR}/db" || die "Déchiffrement impossible : $BACKUP_FILE"
check_db_as_app "${CHECK_DIR}/db" || die "Base de la sauvegarde abîmée."
LAST_MIG="$(run_as_app_argv sqlite3 "${CHECK_DIR}/db" "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;" 2>/dev/null || echo "?")"
ok "Base lisible et intègre (dernière migration : ${LAST_MIG:-?})"
if [[ -n "$RESTORE_UPLOADS" ]]; then
  N_FILES="$(gpg --batch --yes --decrypt --passphrase-file "$KOUZIA_PASSPHRASE_FILE" --output - "$RESTORE_UPLOADS" \
    | run_as_app_argv tar -tzf - | grep -vc '/$' || true)"
  [[ "$N_FILES" =~ ^[0-9]+$ && "$N_FILES" -gt 0 ]] || die "Archive des pièces jointes illisible ou vide : $RESTORE_UPLOADS"
  ok "Pièces jointes lisibles (${N_FILES} fichier(s))"
fi
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  ok "Contrôle terminé, rien n'a été modifié."
  exit 0
fi

if [[ -f "${KOUZIA_STATE_DIR}/update-in-progress" ]]; then
  warn "Une mise à jour est inachevée : kouziactl rollback est peut-être plus adapté (code et données d'avant)."
fi
if [[ "$YES" -ne 1 && -t 0 ]]; then
  echo "  La base actuelle sera remplacée par celle de $(basename "$BACKUP_FILE") (l'actuelle est gardée à côté)."
  echo -n "  Continuer ? [o/N]: "
  read -r ans || ans=""
  [[ "$ans" =~ ^([oOyY]|oui|Oui|OUI)$ ]] || { echo "  Annulé, rien n'a changé."; exit 0; }
fi

if ! restore_backup "$BACKUP_FILE" "$RESTORE_UPLOADS"; then
  warn "Restauration faite mais l'API ne répond pas ou une étape a échoué : kouziactl logs app."
  exit 1
fi
ok "Restore terminé."
