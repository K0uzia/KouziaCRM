#!/usr/bin/env bash
# Affiche une fois les deux clés de secours (clé de chiffrement de l'ERP, phrase des sauvegardes) pour les ranger dans
# un gestionnaire de mots de passe. Sans elles, une sauvegarde est illisible si le CT est perdu.
# Console Proxmox du CT seulement (refusé par SSH), root, terminal interactif, mot de confirmation. Rien n'est écrit
# dans un journal ni un fichier ; seule la date de l'export est gardée (kouziactl status).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

if [[ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]]; then
  die "Refusé par SSH. Ouvrir la console du CT dans Proxmox (CT > Console), se connecter en root, puis : kouziactl cle-export"
fi
require_root
[[ -t 0 && -t 1 ]] || die "Terminal interactif requis (console Proxmox du CT)."

KEY="$(env_file_value "${KOUZIA_APP_DIR}/.env" ENCRYPTION_KEY)"
[[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "ENCRYPTION_KEY absente ou invalide dans ${KOUZIA_APP_DIR}/.env."
[[ -s "$KOUZIA_PASSPHRASE_FILE" ]] || die "Phrase des sauvegardes absente (${KOUZIA_PASSPHRASE_FILE})."
PASS="$(tr -d '\r\n' < "$KOUZIA_PASSPHRASE_FILE")"

cat <<EOF

${C_BOLD}Clés de secours de l'ERP${C_RESET}

Deux valeurs vont s'afficher. Sans elles, aucune sauvegarde ne peut être relue si ce CT est perdu.

  1. Ouvrir votre gestionnaire de mots de passe.
  2. Créer une fiche nommée : ERP Kouzia : clés de secours
  3. Y copier les deux valeurs, chacune avec son nom :
       Clé de chiffrement de l'ERP
       Phrase des sauvegardes
  4. Enregistrer la fiche, puis appuyer sur Entrée ici : l'écran sera effacé.

Ne les envoyez à personne, ne les mettez ni dans un e-mail ni dans un fichier.

EOF
printf 'Taper AFFICHER pour les afficher (autre chose pour annuler) : '
read -r answer || answer=""
if [[ "$answer" != "AFFICHER" ]]; then
  unset KEY PASS
  echo "Annulé, rien n'a été affiché."
  exit 0
fi

printf '\n  Clé de chiffrement de l'"'"'ERP : %s\n  Phrase des sauvegardes      : %s\n\n' "$KEY" "$PASS"
unset KEY PASS
printf 'Appuyer sur Entrée une fois les deux valeurs enregistrées : '
read -r _ || true
# Efface l'écran et l'historique de défilement du terminal.
printf '\033[3J\033[H\033[2J\033c'
ops_state_set keys-exported-at "$(date '+%Y-%m-%d %H:%M')"
ops_state_set keys-exported-fp "$(keys_fingerprint)"
ok "Écran effacé. Date de l'export notée (kouziactl status)."
