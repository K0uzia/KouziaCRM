# KouziaCRM

Outil privé de CRM et facturation pour **Alexandre Kouziaeff** (EI Kouzia) — micro-entreprise, franchise en base de TVA (art. 293 B CGI), activité libérale non réglementée (BNC).

Hébergement cible : **Proxmox (LXC/VM)** + **SQLite** + **Cloudflare Tunnel** (HTTPS sans ouvrir de ports).

## Prérequis

- Node.js 20+
- npm
- (Prod) Docker / Docker Compose

## Démarrage rapide (local)

```bash
cp .env.example .env
# Éditer AUTH_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD
#   openssl rand -base64 32   → AUTH_SECRET
#   openssl rand -hex 32      → ENCRYPTION_KEY

npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
```

Ouvrir [http://localhost:3000](http://localhost:3000) — `ADMIN_EMAIL` / `ADMIN_PASSWORD` du `.env`.

Worker IMAP (terminal séparé) :

```bash
npm run worker
```

## Docker (app + worker + Prisma Studio)

```bash
docker compose up -d --build
```

| Service | Bind | Accès |
|---------|------|--------|
| App | `127.0.0.1:3000` | via Cloudflare Tunnel en prod |
| Worker | — | polling IMAP horaire |
| Prisma Studio | `127.0.0.1:5555` | SSH tunnel uniquement |

Volume persistant : `./data/kouziacrm.db`

### Prisma Studio via SSH

```bash
ssh -L 5555:127.0.0.1:5555 user@lxc-proxmox
# puis http://localhost:5555
```

## Déploiement Proxmox + Cloudflare Tunnel

1. Créer un LXC Ubuntu 24.04 (2 vCPU, 2 Go RAM, 16 Go) + Docker.
2. Cloner le repo dans `/opt/kouziacrm`, renseigner `.env` :
   - `AUTH_URL=https://gestion.<domaine>`
   - SMTP / IMAP
   - secrets auth & chiffrement
3. `docker compose up -d --build`
4. Dans Cloudflare Zero Trust → Tunnel → Public Hostname :
   - Hostname : `gestion.<domaine>`
   - Service : `http://127.0.0.1:3000`
5. Option : décommenter le service `cloudflared` dans `docker-compose.yml` et ajouter `CLOUDFLARE_TUNNEL_TOKEN` au `.env`.
6. Backup quotidien : `cp data/kouziacrm.db /backup/kouzia-$(date +%F).db`

**Pourquoi Cloudflare Tunnel plutôt que NPM :** pas d’ouverture 80/443 sur la box, TLS géré par Cloudflare, adapté CGNAT.

## Enveloppes / Tunnel de cashflow

**Décalage M / M+1 (obligatoire) :**

| Module | Base | Rôle |
|--------|------|------|
| Bannière / carte échéance | CA encaissé **M-1** (ou T-1) | Montant **dû** via **Publicodes** (`modele-social`) |
| Tunnel cashflow | CA encaissé **M** | URSSAF = Publicodes ; frais/placements = % paramétrables |

Bouton **Marquer comme payé** → modèle `UrssafDeclaration` (historique Banque / Virements).
Périodicité Mensuelle / Trimestrielle dans **Paramètres**.

## Email (SMTP + IMAP)

Renseigner dans `.env` :

- `SMTP_*` — envoi (Nodemailer)
- `IMAP_*` — réception (polling horaire via `worker`)

## Scripts

| Commande | Description |
|----------|-------------|
| `npm run dev` | Serveur de développement |
| `npm run worker` | Polling IMAP (cron horaire) |
| `npm run db:deploy` | Appliquer migrations SQLite |
| `npm run db:seed` | Admin + identité entreprise (INPI) |
| `npm run db:studio` | Prisma Studio |
| `npm test` | Tests unitaires |

## Conformité MVP

- Numérotation séquentielle `YYYY-NNN` allouée **uniquement à l’émission** (increment atomique SQLite)
- Pas de suppression de facture — annulation via **avoir**
- Mentions PDF : EI, SIREN/SIRET, « TVA non applicable, art. 293 B du CGI »
- Enveloppes 21,30 % / 14,20 % / solde sur **CA encaissé**
- Chiffrement AES-256-GCM des email / téléphone / SIRET clients

## Sauvegarde

```bash
cp data/kouziacrm.db backup-$(date +%F).db
```

## Identité seedée

- SIREN `108580028` / SIRET `10858002800018`
- 13 Le Petit Moulin, 29690 Huelgoat
- Nom commercial : Kouzia
