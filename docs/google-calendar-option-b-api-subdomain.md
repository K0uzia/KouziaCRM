# Google Agenda : option B (permanente) — `api.kouzia.com`

Objectif : login Google + sync Agenda, **sans** casser le site Hostinger `kouzia.com`,
**sans** SSH, **sans** tunnel jetable au quotidien.

| Rôle | URL | Où ça tourne |
|------|-----|----------------|
| Site / suivi | `https://kouzia.com` | Hostinger (inchangé) |
| API CRM (OAuth, webhooks) | `https://api.kouzia.com` | CT via Cloudflare Tunnel |
| Admin ERP | `http://192.168.1.52:3000` | LAN uniquement |

Après Google, Kouzia te renvoie tout seul sur le LAN (`WEB_ORIGIN`).

---

## 0. Nettoyage (si tu as testé `earpip`)

1. Cloudflare → Tunnels → ton tunnel → **Routes** → supprimer `earpip.kouzia.com`
2. Hostinger → DNS `kouzia.com` → supprimer le CNAME `earpip`

---

## 1. Cloudflare — route du tunnel

1. Va sur [dash.cloudflare.com](https://dash.cloudflare.com) → **Networking** → **Tunnels**
2. Clique le **nom** de ton tunnel (celui déjà sur le CT)
3. **Routes** → **Add route**
4. Type : **Published application** / **Application publiée**  
   (pas Private network, pas Add replica, pas Refresh token)
5. Remplir **exactement** :

| Champ | Valeur |
|--------|--------|
| Hostname | `api` + domaine `kouzia.com` → **`api.kouzia.com`** |
| Service URL | **`http://127.0.0.1:3000`** |

6. **Add route** / Enregistrer

Sur le CT, les logs cloudflared doivent finir par montrer un ingress du genre  
`hostname":"api.kouzia.com" … "http://127.0.0.1:3000"`.

---

## 2. Hostinger — DNS (un seul enregistrement)

hPanel → **Domaines** → **kouzia.com** → **DNS** → Ajouter :

| Type | Nom | Cible | TTL |
|------|-----|--------|-----|
| **CNAME** | `api` | `a41fd065-e8a2-422a-954b-f03efaf816a3.cfargotunnel.com` | 3600 |

Règles :
- Nom = `api` **seul** (pas `api.kouzia.com`)
- Cible **sans** `https://`, **sans** slash
- Si Hostinger exige un point final :  
  `a41fd065-e8a2-422a-954b-f03efaf816a3.cfargotunnel.com.`

> Tunnel ID (déjà le tien) : `a41fd065-e8a2-422a-954b-f03efaf816a3`  
> Si tu as régénéré le token tunnel, récupère le nouvel ID :
> ```bash
> node -e 'const t=require("fs").readFileSync("/etc/kouzia/cloudflare-tunnel.token","utf8").trim();const p=JSON.parse(Buffer.from((t.split(".")[1]||t).replace(/-/g,"+").replace(/_/g,"/"),"base64").toString());console.log(p.t+".cfargotunnel.com")'
> ```

Attends 2–10 minutes.

---

## 3. Tests sur le CT (obligatoire avant Google)

```bash
# DNS public
nslookup api.kouzia.com 1.1.1.1

# Doit montrer un CNAME vers …cfargotunnel.com
# et des IP publiques (104.x / 172.64.x), PAS seulement fd10:…

curl -4 -sI --connect-timeout 10 https://api.kouzia.com/api/health
```

| Résultat | Action |
|----------|--------|
| **HTTP 200** | OK → étape 4 |
| NXDOMAIN | CNAME pas encore propagé / faute de frappe → revérifier Hostinger |
| `no data` / seulement `fd10:` | Voir § Dépannage DNS ci-dessous |
| 502 | `rc-service kouziacrm status` et `rc-service cloudflared status` |

API locale (contrôle) :

```bash
curl -sI http://127.0.0.1:3000/api/health
```

→ doit rester **200**.

---

## 4. Google Cloud — URI de redirection

Client OAuth **Application Web** → **URI de redirection autorisés** → Ajouter :

```text
https://api.kouzia.com/api/google/calendar/callback
```

Enregistrer. Garder **ID client** + **Secret** (déjà faits si tu les as).

---

## 5. CT — `.env` Kouzia

Dans `/opt/kouziacrm/.env` :

```bash
PUBLIC_API_ORIGIN="https://api.kouzia.com"
GOOGLE_CLIENT_ID="….apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-…"
GOOGLE_REDIRECT_URI="https://api.kouzia.com/api/google/calendar/callback"
WEB_ORIGIN="http://192.168.1.52:3000"
```

- `PUBLIC_WEB_ORIGIN` / site = reste `https://kouzia.com` (ne pas y mettre `api.`)
- Ne mets **pas** l’IP LAN dans `PUBLIC_API_ORIGIN`

```bash
rc-service kouziacrm restart
# ou : kouziactl google  (après update script : 3 champs ID / secret / redirect)
```

---

## 6. Connexion Google (navigateur)

1. Ouvre `http://192.168.1.52:3000/settings?tab=declarations`
2. **Connecter Google Agenda**
3. Compte Gmail (utilisateur de test) → autoriser
4. Retour sur le LAN avec toast « connecté »

Ensuite : sync Agenda = CT tout seul. Pas de tunnel jetable, pas de SSH.

---

## Dépannage DNS (`fd10` / `curl -4` no data)

Si tu vois :

```text
api.kouzia.com  canonical name = ….cfargotunnel.com
Address: fd10:aec2:5dae::
```

et **pas** d’IP `104.x` / `172.64.x` : le CNAME Hostinger est bon, mais Cloudflare
ne publie pas d’IP publique pour un CNAME « externe ». Google / `curl -4` échouent.

### Correctif obligatoire : DNS `kouzia.com` chez Cloudflare (Free)

Une seule migration nameservers. Ensuite `api` est **Proxied** (nuage orange) et
résout vers des IP Cloudflare publiques. Le site `kouzia.com` peut rester chez Hostinger
comme origine.

1. Va sur [dash.cloudflare.com](https://dash.cloudflare.com) (compte qui a déjà ton tunnel)
2. Menu de gauche : **Domains** / **Domaines** (pas Zero Trust, pas Tunnels)
3. Bouton **Onboard a domain** / **Ajouter un domaine**  
   (anciennement « Add a site » — le libellé a changé)
4. Domaine : **`kouzia.com`** (apex, sans `www`, sans `api.`)
5. Continue → choisis le plan **Free** / **Gratuit**
6. Laisse scanner / importer les DNS → vérifie MX Hostinger + A/CNAME du site
7. Continue → note les **2 nameservers** Cloudflare affichés
8. **Hostinger** → Domaines → `kouzia.com` → **Nameservers** → personnalisés  
   = les 2 nameservers Cloudflare (remplace ceux de Hostinger)
9. Attends le statut **Active** sur Cloudflare (souvent 5–60 min, parfois plus)
10. Cloudflare → domaine `kouzia.com` → **DNS** → enregistrement `api` :
    - Type **CNAME**
    - Nom `api`
    - Cible `a41fd065-e8a2-422a-954b-f03efaf816a3.cfargotunnel.com`
    - **Proxy : Proxied** (nuage **orange**, pas gris)
    - Ou recrée la route tunnel Published application `api.kouzia.com` pour que Cloudflare crée le DNS
11. Supprime le CNAME `api` resté chez Hostinger s’il existe encore

Lien direct onboarding : [dash.cloudflare.com/?to=/:account/domains/new](https://dash.cloudflare.com/?to=/:account/domains/new)

Reteste :

```bash
nslookup api.kouzia.com 1.1.1.1
# doit montrer des IP 104.x / 172.64.x (plus seulement fd10)

curl -4 -sI --connect-timeout 10 https://api.kouzia.com/api/health
# HTTP 200
```

Sans nuage orange / sans zone Cloudflare, l’option B **ne peut pas** marcher avec le DNS Hostinger seul (limitation actuelle côté résolution `*.cfargotunnel.com`).

---

## Récap des valeurs

| Quoi | Valeur |
|------|--------|
| Hostname API | `api.kouzia.com` |
| Service tunnel | `http://127.0.0.1:3000` |
| CNAME Hostinger | `api` → `a41fd065-e8a2-422a-954b-f03efaf816a3.cfargotunnel.com` |
| Callback Google | `https://api.kouzia.com/api/google/calendar/callback` |
| ERP | `http://192.168.1.52:3000` |
| Site public | `https://kouzia.com` (Hostinger, inchangé) |
