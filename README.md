# KouziaCRM

Outil privé de CRM et facturation pour **Alexandre Kouziaeff** (EI Kouzia)  -  micro-entreprise, franchise en base de TVA (art. 293 B CGI), activité libérale non réglementée (BNC).

Stack : **Fastify + Prisma + SQLite** (API) · **Vite + React + TypeScript + Tailwind + Font Awesome** (SPA).

Hébergement cible : **Proxmox (LXC/VM)** + **SQLite** + **Cloudflare Tunnel**.

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

Connexion : `ADMIN_EMAIL` / `ADMIN_PASSWORD` du `.env`.

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
apps/api   Fastify  -  auth sessions SQLite, métier, PDF, sert le build web en prod
apps/web   Vite React SPA
prisma/    schéma + migrations SQLite
scripts/   worker IMAP
data/      kouziacrm.db
```

## Docker (app + worker + Prisma Studio)

```bash
docker compose up -d --build
```

| Service | Bind | Accès |
|---------|------|--------|
| App | `127.0.0.1:3000` | SPA + API |
| Worker |  -  | polling IMAP horaire |
| Prisma Studio | `127.0.0.1:5555` | SSH tunnel uniquement |

Volume persistant : `./data/kouziacrm.db`

## Déploiement Proxmox + Cloudflare Tunnel

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

### Mise en place (une seule fois, sur l'hôte Proxmox)

```bash
apt install sqlite3 gnupg
echo "passphrase-forte-aleatoire" | sudo tee /etc/kouzia-backup-pass >/dev/null
sudo chmod 600 /etc/kouzia-backup-pass
```

### Cron quotidien (crontab -e)

```
0 2 * * * /opt/kouziacrm/scripts/backup.sh
```

Le script :
- fait un `sqlite3 .backup` (cohérent, gère le WAL)
- vérifie `PRAGMA integrity_check`
- chiffre en AES-256 via GPG (passphrase hors du repo)
- copie dans `/backup/kouzia/kouziacrm-AAAA-MM-JJ.db.gpg`
- rotation automatique 30 jours
- log dans `/var/log/kouzia-backup.log`

Variables configurables (env) : `KOUZIA_DB_PATH`, `KOUZIA_BACKUP_DIR`,
`KOUZIA_RETENTION_DAYS`, `KOUZIA_PASSPHRASE_FILE`, `KOUZIA_LOG_FILE`.

### Restore (test mensuel conseillé)

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
| `make dev` | API + Vite en parallèle |
| `make app` | Build web + API qui sert la SPA |
| `make worker` | Sync IMAP horaire |
| `make db-deploy` / `make db-seed` | Base |

## Conformité MVP

- Numérotation configurable par série (défaut `F-{year}-{counter}` → ex. `F-2026-0001`), allouée à l'émission uniquement
- Pas de suppression de facture  -  avoir
- Mentions PDF franchise TVA art. 293 B
- Enveloppes sur CA encaissé

## Identité seedée

- SIREN `108580028` / SIRET `10858002800018`
- 13 Le Petit Moulin, 29690 Huelgoat
- Nom commercial : Kouzia
