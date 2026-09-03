# KouziaCRM

Outil privé de CRM et facturation pour **Alexandre Kouziaeff** (EI Kouzia)  -  micro-entreprise, franchise en base de TVA (art. 293 B CGI), activité libérale non réglementée (BNC).

Stack : **Fastify + Prisma + SQLite** (API) · **Vite + React + TypeScript + Tailwind + Font Awesome** (SPA).

Hébergement cible : **Proxmox CT Alpine** (natif OpenRC) ou Ubuntu+Docker + **SQLite** + **Cloudflare Tunnel**.

## Prérequis

- Node.js 20+
- npm
- (Prod) Docker / Docker Compose

## Démarrage rapide (local)

```bash
make setup
# Éditer .env : SESSION_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD
#   openssl rand -base64 32   → SESSION_SECRET
#   openssl rand -hex 32      → ENCRYPTION_KEY

make dev
```

- Front : [http://localhost:5173](http://localhost:5173) (HMR Vite, proxy `/api` → API)
- API : [http://localhost:3001](http://localhost:3001)
- Mailpit (SMTP local) : [http://localhost:8025](http://localhost:8025) : démarré automatiquement par `make dev` (binaire local dans `.tools/`, pas de Docker)

Connexion : `ADMIN_EMAIL` / `ADMIN_PASSWORD` du `.env`.

SMTP local : le `.env` pointe vers Mailpit (`127.0.0.1:1025`). Les mails envoyés depuis l’UI apparaissent dans Mailpit. Arrêt : `make mailpit-stop`.

### Mode « outil » (build + servir SPA + API)

```bash
make app
# → http://localhost:3000
```

Worker IMAP (terminal séparé) :

```bash
make worker
```

## Architecture

```
apps/api              Fastify  -  auth sessions SQLite, métier, PDF, sert le build web en prod
apps/web              Vite React SPA
packages/kouzia-forms Logique partagée (adresse BAN, SIREN, cache) utilisée aussi par le site Kouzia
prisma/               schéma + migrations SQLite
scripts/              worker IMAP
data/                 kouziacrm.db
```

## Formulaire client public (Kouzia)

Flux :

1. Depuis l'ERP, invitation email (`POST /api/onboarding/invite`) : génère un token HMAC
   (`ONBOARDING_HMAC_SECRET`) et un enregistrement `OnboardingInvitation` (jti, expiration).
2. Le client ouvre `https://kouzia.fr/nouveau-client?token=...`.
3. Kouzia appelle `GET /api/public/clients/preview` puis `POST /api/public/clients`
   (CORS limité à `PUBLIC_WEB_ORIGIN`). Aucune donnée n'est stockée sur Kouzia.
4. L'ERP revalide adresse (BAN) et SIREN (recherche-entreprises), crée/met à jour le client.

### Portail client (suivi devis / acomptes)

Workflow : le client **valide d'abord le devis** (portail `/suivi` ou réponse email), puis reçoit le lien de paiement de l'acompte. La confirmation de paiement part après encaissement Revolut.

| Variable | Rôle |
|----------|------|
| `CLIENT_PORTAL_URL` | Lien `/suivi` inséré dans les emails (ex. `https://kouzia.com/suivi`) |
| Dev local | `http://localhost:5174/suivi` (site Kouzia sur :5174) |

Variables à ajouter dans `.env` :

| Variable | Rôle |
|----------|------|
| `ONBOARDING_HMAC_SECRET` | Secret HMAC des liens (openssl rand -hex 32) |
| `ONBOARDING_TOKEN_TTL_DAYS` | Durée de validité (défaut 7) |
| `PUBLIC_WEB_ORIGIN` | Origine Kouzia (CORS + lien email) |
| `CLIENT_PORTAL_URL` | URL espace client `/suivi` (emails devis, paramètres ERP) |
| `VITE_PUBLIC_SITE_URL` | Redirection legacy `/onboarding/:token` |

## Docker (app + worker + Prisma Studio)

```bash
docker compose up -d --build
```

| Service | Bind | Accès |
|---------|------|--------|
| App | `127.0.0.1:3000` | SPA + API |
| Worker |  -  | polling IMAP horaire |
| Prisma Studio | `127.0.0.1:5555` | SSH tunnel uniquement |

Volume persistant : `./data/kouziacrm.db` (sur l'hôte Proxmox, **pas dans l'image Docker**).

### Mise à jour après modification du code

```bash
bash scripts/deploy.sh
# équivalent : git pull && docker compose build app && docker compose up -d
```

- **Ne pas utiliser `--no-cache`** sauf dépannage (force un rebuild complet ~1 h sur petit CT).
- Le cache Docker réutilise `npm ci` tant que `package-lock.json` ne change pas.
- Une seule image (`kouziacrm:latest`) sert app, worker et prisma-studio.
- **`docker compose down` ne supprime pas `./data`** (volume bind sur le disque hôte).
- **Ne jamais** `rm -rf data/` ni restaurer une vieille image par-dessus la base sans backup.

Premier build : long (npm + build SPA). Mises à jour code seul : quelques minutes (rebuild des layers `COPY . .` et build web uniquement).

## Déploiement Proxmox + Cloudflare Tunnel

### Recommandé : CT Alpine natif (sans Docker)

Léger, OpenRC, mises à jour sans rebuild complet, backup SQLite + rsync offsite.

Sur le CT Alpine 3.21+ (unprivileged OK) :

```bash
# Option A : depuis un clone déjà présent
apk add bash git
git clone https://github.com/K0uzia/KouziaCRM.git /opt/kouziacrm
bash /opt/kouziacrm/scripts/alpine/install.sh

# Option B : rsync depuis votre machine de dev, puis install sur le CT
./scripts/alpine/deploy-rsync.sh root@CT_IP --skip-update
ssh root@CT_IP 'bash /opt/kouziacrm/scripts/alpine/install.sh'
```

Puis :

1. Éditer `/opt/kouziacrm/.env` (`WEB_ORIGIN`, SMTP, IMAP).
2. Cloudflare Tunnel → `http://127.0.0.1:3000`.
3. Optionnel : `/etc/kouzia/rsync.env` pour pousser les backups chiffrés hors du CT.

| Commande | Rôle |
|----------|------|
| `kouziactl status` | Services, health, disque, backups |
| `kouziactl update` | Update incrémental (npm/build seulement si besoin) |
| `kouziactl update --git` | `git pull` + update |
| `./scripts/alpine/deploy-rsync.sh user@ct` | Depuis le PC : rsync code + update distant |
| `kouziactl backup` / `restore` | Backup GPG + rsync / restore |

Détails : `scripts/alpine/` (install, update, backup, restore, OpenRC, conf rsync).

### Alternative : LXC Ubuntu + Docker

1. LXC Ubuntu 24.04 + Docker.
2. Cloner dans `/opt/kouziacrm`, renseigner `.env` :
   - `WEB_ORIGIN=https://gestion.<domaine>`
   - `COOKIE_SECURE=true`
   - `API_PORT=3000`
   - SMTP / IMAP + secrets
3. `docker compose up -d --build`
4. Cloudflare Tunnel → `http://127.0.0.1:3000`
5. Backup : voir section « Backup & restore » ci-dessous (ne pas utiliser `cp` brut)

## Backup & restore

Le backup utilise l'API SQLite (`.backup`) qui gère correctement le mode WAL,
contrairement à un `cp` brut qui peut produire un fichier incohérent.

# Mise en place (une seule fois)

Alpine (fait par install.sh) : passphrase dans `/etc/kouzia/backup-pass`,
backups dans `/var/backup/kouzia`, cron `/etc/periodic/daily/kouzia-backup`.

Docker / Ubuntu hôte Proxmox :

```bash
apt install sqlite3 gnupg rsync
echo "passphrase-forte-aleatoire" | sudo tee /etc/kouzia-backup-pass >/dev/null
sudo chmod 600 /etc/kouzia-backup-pass
# Optionnel offsite : cp scripts/alpine/conf/rsync.env.example /etc/kouzia/rsync.env
```

### Cron quotidien

Alpine : déjà via `/etc/periodic/daily` (crond).

Docker / Ubuntu (`crontab -e`) :

```
0 2 * * * /opt/kouziacrm/scripts/backup.sh
```

Le script Alpine (`kouziactl backup`) :
- fait un `sqlite3 .backup` (cohérent, gère le WAL)
- vérifie `PRAGMA integrity_check`
- chiffre en AES-256 via GPG (passphrase hors du repo)
- archive meta (`.env` + migrations) et uploads si présents
- copie dans `/var/backup/kouzia/kouziacrm-….db.gpg`
- rotation automatique 30 jours
- rsync optionnel vers cible distant
- log dans `/var/log/kouzia/backup.log`

Le script Docker (`scripts/backup.sh`) fait de même pour la DB (chemin
`/backup/kouzia` par défaut) + rsync si `/etc/kouzia/rsync.env` est renseigné.

Variables configurables (env) : `KOUZIA_DB_PATH`, `KOUZIA_BACKUP_DIR`,
`KOUZIA_RETENTION_DAYS`, `KOUZIA_PASSPHRASE_FILE`, `KOUZIA_LOG_FILE`.

Rsync offsite (Docker ou Alpine) : créer `/etc/kouzia/rsync.env` à partir de
`scripts/alpine/conf/rsync.env.example` (`KOUZIA_RSYNC_TARGET=…`). Sur Alpine,
préférer `kouziactl backup` (DB + meta `.env` + uploads, puis rsync).

### Restore (test mensuel conseillé)

Alpine :

```bash
kouziactl restore /var/backup/kouzia/kouziacrm-2026-08-27.db.gpg
# avec pièces jointes :
kouziactl restore /var/backup/kouzia/….db.gpg --uploads /var/backup/kouzia/….uploads.tar.gz.gpg
```

Docker :

```bash
cd /opt/kouziacrm
docker compose stop app worker
gpg -d /backup/kouzia/kouziacrm-2026-08-27.db.gpg | sqlite3 data/kouziacrm.db.restore
mv data/kouziacrm.db data/kouziacrm.db.broken
mv data/kouziacrm.db.restore data/kouziacrm.db
docker compose start app worker
```

## Sécurité

- Sessions **serveur** (table `Session`) + cookie `httpOnly` / `SameSite=Lax`
- Mots de passe **argon2id** (migration auto depuis bcrypt au login)
- Rate-limit login, Helmet, contrôle Origin sur mutations
- PII clients (email / téléphone / SIRET) : AES-256-GCM (`ENCRYPTION_KEY`)

## Makefile

| Commande | Description |
|----------|-------------|
| `make setup` | `.env`, install, migrations, seed |
| `make dev` | Mailpit + API + Vite en parallèle |
| `make mailpit` / `make mailpit-stop` | SMTP catcher local (UI :8025) |
| `make app` | Build web + API qui sert la SPA |
| `make worker` | Sync IMAP horaire |
| `make db-deploy` / `make db-seed` | Base |
| `make alpine-deploy HOST=user@ct` | Rsync + update incrémental vers CT Alpine |
| `make alpine-status HOST=user@ct` | Status distant |

## Conformité MVP

- Numérotation configurable par série (défaut `F-{year}-{counter}` → ex. `F-2026-0001`), allouée à l'émission uniquement
- Pas de suppression de facture  -  avoir
- Mentions PDF franchise TVA art. 293 B
- Enveloppes sur CA encaissé

## Identité seedée

- SIREN `108580028` / SIRET `10858002800018`
- 13 Le Petit Moulin, 29690 Huelgoat
- Nom commercial : Kouzia
