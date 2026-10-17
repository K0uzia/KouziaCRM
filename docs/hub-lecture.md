# Lecture des clients par le hub Kouzia

Le hub (autre CT du Proxmox) lit la liste des clients de l'ERP pour rattacher un site à un client.
Il ne reçoit que quatre informations par client : identifiant, numéro, nom affiché et type.
Ni e-mail, ni adresse, ni téléphone, ni SIRET, ni notes. Il ne peut rien modifier.

Cette lecture passe par une porte à part (port 3100 par défaut), ouverte seulement sur le réseau
local du Proxmox. Elle n'existe ni sur `erp.kouzia.com`, ni sur `api.kouzia.com`, ni sur le port
habituel de l'ERP (3000). Tant que les réglages ci-dessous ne sont pas posés, la porte reste fermée.

## Ce qu'il faut poser (une seule fois)

Prérequis : les deux CT ont une IP fixe sur le réseau local (IP statique ou réservation DHCP).
Si l'IP du CT de l'ERP change, la porte ne s'ouvre pas (l'ERP, lui, fonctionne normalement).

### 1. Noter les deux IP

- IP du CT de l'ERP : `kouziactl summary` (ligne IP LAN), ou `ip -4 addr` dans le CT.
- IP du CT du hub : même commande `ip -4 addr` dans le CT du hub.

Dans la suite, on prend l'exemple `192.168.1.20` pour l'ERP et `192.168.1.30` pour le hub.

### 2. Créer le secret partagé

Sur n'importe quel CT :

```bash
openssl rand -hex 32
```

La valeur affichée va dans le `.env` de l'ERP **et** dans celui du hub (même valeur des deux côtés).
Ne la recopiez nulle part ailleurs.

### 3. Réglages de l'ERP

Dans le CT de l'ERP, ouvrir `/opt/kouziacrm/.env` et ajouter :

```bash
HUB_READ_SECRET="la valeur de l'étape 2"
HUB_ALLOWED_IPS="192.168.1.30"
HUB_LISTEN="192.168.1.20:3100"
```

- `HUB_ALLOWED_IPS` : l'IP du CT du hub, seule autorisée à lire.
- `HUB_LISTEN` : l'IP du CT de l'ERP, suivie de `:3100`. `0.0.0.0` est refusé exprès.

Puis :

```bash
kouziactl restart
grep "\[hub\]" /var/log/kouzia/app.log | tail -n 3
```

La dernière ligne doit dire `lecture par le hub sur 192.168.1.20:3100`. Si elle dit
`écouteur non démarré`, la suite de la ligne donne la raison (IP mal recopiée, par exemple).

### 4. Pare-feu Proxmox : port 3100 ouvert au seul hub

Dans l'interface web du Proxmox :

1. **Centre de données > Pare-feu > Options** : si « Pare-feu » est sur « Non », vérifier d'abord
   que « Politique d'entrée » est sur **ACCEPT** (sinon l'hôte Proxmox lui-même deviendrait
   injoignable), puis passer « Pare-feu » sur « Oui ».
2. **CT de l'ERP > Réseau** : modifier la carte `net0` et cocher **Pare-feu**.
3. **CT de l'ERP > Pare-feu > Options** :
   - « Politique d'entrée » sur **ACCEPT** (l'ERP reste joignable comme aujourd'hui sur le
     réseau local et par Tailscale) ;
   - « Pare-feu » sur « Oui ».
4. **CT de l'ERP > Pare-feu**, ajouter deux règles, dans cet ordre (la première en haut) :

   | Direction | Action | Source | Protocole | Port de destination | Commentaire |
   |---|---|---|---|---|---|
   | in | ACCEPT | `192.168.1.30` | tcp | 3100 | hub Kouzia |
   | in | DROP | (vide) | tcp | 3100 | port du hub fermé aux autres |

   Cocher « Activer » sur les deux.

### 5. Réglage du hub

Dans le `.env` du hub : `ERP_BASE_URL="http://192.168.1.20:3100"` et `HUB_READ_SECRET` avec la
valeur de l'étape 2, puis redémarrer le hub.

### 6. Vérifier

- Depuis le CT du hub : `curl -s -o /dev/null -w "%{http_code}\n" http://192.168.1.20:3100/api/hub/clients`
  affiche `404`. C'est normal : la requête n'est pas signée. Le hub, lui, signe ses requêtes.
- Dans le hub, le bandeau « ERP indisponible » disparaît et la liste des clients s'affiche.
- Depuis un autre poste du réseau, la même commande `curl` n'obtient aucune réponse (pare-feu).

## Fermer la porte

Retirer `HUB_LISTEN` (ou `HUB_READ_SECRET`) du `.env`, puis `kouziactl restart`. Changer de secret :
nouvelle valeur des deux côtés, puis redémarrer l'ERP et le hub.

## Installation Docker

Pas prise en charge pour l'instant : dans un conteneur, l'IP change à chaque recréation et
`HUB_LISTEN` refuse `0.0.0.0`. L'installation recommandée (CT Alpine) est celle décrite ci-dessus.

## Contrôles faits par l'ERP

Chaque requête doit venir d'une IP de `HUB_ALLOWED_IPS`, hors du tunnel Cloudflare, porter une
signature valide (HMAC-SHA256 du secret partagé) et un horodatage à moins de 5 minutes ; au plus
60 requêtes par minute. Tout refus répond la même 404, sans dire pourquoi. Le journal de l'ERP note
le motif du refus, jamais la signature ni les noms des clients.
