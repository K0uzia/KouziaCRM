# Tailscale : accès admin ERP depuis le téléphone

Guide pour joindre l'interface admin KouziaCRM (hébergée sur un CT Proxmox Alpine)
depuis n'importe où, sans ouvrir de ports et **sans exposer l'ERP sur Internet**.

Le site public `kouzia.com`, les webhooks Revolut et le callback Google Calendar
continuent de passer par **Cloudflare Tunnel**. Tailscale ne remplace pas ce tunnel.

## Prérequis

- CT Alpine (install `kouziactl` déjà faite)
- Compte Tailscale perso (gratuit pour un usage solo)
- Tunnel Cloudflare déjà OK pour l'API publique (`PUBLIC_API_ORIGIN` en `https://…`)
- Téléphone : app [Tailscale](https://tailscale.com/download) (même compte)

## Deux portes, une seule API

```
kouzia.com / webhooks / OAuth Google
    HTTPS  →  Cloudflare Tunnel  →  127.0.0.1:$API_PORT

Téléphone / PC distant
    VPN    →  Tailscale MagicDNS  →  0.0.0.0:$API_PORT (même process)

PC maison (Wi-Fi)
    LAN    →  http://IP-DU-CT:$API_PORT
```

| Variable | Rôle | Exemple |
|----------|------|---------|
| `WEB_ORIGIN` | URL admin que tu tapes le plus souvent (CORS + cookies + retour OAuth Google) | `http://192.168.1.50:3000` |
| `TAILSCALE_ORIGIN` | Origine MagicDNS (CORS téléphone), **en plus** de `WEB_ORIGIN` | `http://kouzia.tailnet-xxxx.ts.net:3000` |
| `PUBLIC_API_ORIGIN` | URL **HTTPS Cloudflare** uniquement (jamais Tailscale, jamais LAN) | `https://gestion.kouzia.fr` |
| `PUBLIC_WEB_ORIGIN` | Site public (CORS `/api/public/*`) | `https://kouzia.com` |
| `COOKIE_SECURE` | `false` (admin en HTTP LAN / MagicDNS) | `false` |
| `TRUST_PROXY` | `true` si Cloudflare Tunnel est actif | `true` |

`PUBLIC_API_ORIGIN` ne doit **jamais** devenir une IP `100.x` ni un hostname `.ts.net`.
Sinon Revolut, Google Calendar et `kouzia.com` cassent.

## 1. Compte Tailscale

1. Ouvre [https://login.tailscale.com](https://login.tailscale.com) (Google / Microsoft / GitHub / mail)
2. Sur le **téléphone** : installe Tailscale, connecte-toi avec **le même compte**
3. Laisse **exit node désactivé** (sinon tout le trafic 4G transite par la maison)
4. Optionnel : active la connexion auto / on-demand dans l'app

Ne crée pas un second compte : le CT et le téléphone doivent être sur le **même tailnet**.

## 2. Sur le CT : `kouziactl tailscale`

Après un `kouziactl update` qui apporte Tailscale (ou une autre nouveauté),
l'assistant **Nouveautés de configuration** propose de le régler tout de suite
(défaut oui). Tu peux aussi le lancer sans attendre :

```bash
kouziactl new-config
# ou directement :
kouziactl tailscale
```

Menu : **Configuration → Tailscale** (ou Mise à jour → Nouveautés config).

L'assistant :

1. Active le dépôt Alpine `community` si besoin, installe `apk add tailscale`
2. Si `/dev/net/tun` est absent (CT unprivileged) : `TAILSCALED_OPTS="--tun=userspace-networking"`
3. Démarre le service OpenRC `tailscale`
4. Auth :
   - **URL de login** (défaut) : ouvre le lien `https://login.tailscale.com/a/…` sur le PC ou le téléphone déjà connecté
   - **Auth key** : admin Tailscale → Settings → Keys → Generate auth key (`tskey-auth-…`)
5. Force `tailscale up --accept-dns=false` (MagicDNS **ne doit pas** réécrire `/etc/resolv.conf`)
6. Propose `TAILSCALE_ORIGIN=http://<hostname>.<tailnet>.ts.net:$API_PORT`
7. Option : copier cette URL dans `WEB_ORIGIN` (utile si tu ouvres surtout l'ERP au téléphone, y compris pour le retour OAuth Google). **Ne touche pas** `PUBLIC_API_ORIGIN`.

Assistant complet (`kouziactl configure`) : Tailscale est proposé **après** Cloudflare, défaut **non** (install existante inchangée).
`kouziactl update` : défaut **oui** pour une nouveauté encore vide (une seule fois ; « non » = plus tard via `kouziactl tailscale`).

## 3. Téléphone

1. VPN Tailscale allumé (icône dans la barre)
2. Navigateur : l'URL affichée en `TAILSCALE_ORIGIN` (MagicDNS, port de l'API)
3. Bookmark / « Ajouter à l'écran d'accueil »
4. Login ERP (email + mot de passe admin) : Tailscale authentifie l'appareil, pas le compte métier

À la maison en Wi-Fi, l'URL LAN (`WEB_ORIGIN`) continue de marcher si tu ne l'as pas remplacée.

## 4. Vérifications

| Contrôle | Attendu |
|----------|---------|
| `kouziactl status` | service `tailscale` started, ligne Tailscale / TS IP |
| `tailscale status` | CT et téléphone `active` |
| Téléphone, VPN on | login ERP sur `TAILSCALE_ORIGIN` |
| `kouzia.com` suivi / nouveau-client | inchangé (Cloudflare) |
| SMTP / IMAP depuis le CT | toujours Hostinger, pas de timeout DNS |

```bash
kouziactl status
tailscale ip -4
tailscale status
```

## 5. Option Proxmox : `/dev/net/tun` (hors script)

Le mode userspace suffit : l'API écoute déjà `0.0.0.0`. Pour le mode kernel (un peu plus léger) :

Sur l'**hôte** Proxmox, fichier `/etc/pve/lxc/<ID>.conf` :

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

Redémarrer le CT, puis `kouziactl tailscale` : le script détecte le TUN et n'active plus userspace.

## `.env` attendu (prod)

```bash
WEB_ORIGIN="http://192.168.1.50:3000"
TAILSCALE_ORIGIN="http://kouzia.tailnet-xxxx.ts.net:3000"
PUBLIC_API_ORIGIN="https://gestion.kouzia.fr"
PUBLIC_WEB_ORIGIN="https://kouzia.com"
COOKIE_SECURE="false"
TRUST_PROXY="true"
```

Si l'ERP est ouvert **surtout** via MagicDNS (téléphone + PC avec Tailscale) :

```bash
WEB_ORIGIN="http://kouzia.tailnet-xxxx.ts.net:3000"
TAILSCALE_ORIGIN="http://kouzia.tailnet-xxxx.ts.net:3000"
PUBLIC_API_ORIGIN="https://gestion.kouzia.fr"
```

Redémarrer après changement : `kouziactl restart` (le wizard le fait déjà).

## Dépannage

**NeedsLogin / URL de login qui ne s'affiche pas**  
`rc-service tailscale status`, logs : `kouziactl logs tailscale`. Relancer `kouziactl tailscale`.

**tun / operation not permitted**  
CT unprivileged sans `/dev/net/tun` : le wizard doit poser `--tun=userspace-networking`. Vérifier `/etc/conf.d/tailscale`. Sinon passer le TUN (section 5).

**Login ERP 403 Origin non autorisée**  
L'URL tapée n'est ni `WEB_ORIGIN` ni `TAILSCALE_ORIGIN` (http vs https, port, MagicDNS vs `100.x`). Aligner exactement, puis restart.

**Cookies / session qui ne tient pas**  
`COOKIE_SECURE=true` alors que l'URL est en `http://`. Garder `false` pour LAN et MagicDNS HTTP.

**DNS cassé sur le CT (SMTP Hostinger, Cloudflare Down)**  
`--accept-dns` a été oublié : MagicDNS a pris `/etc/resolv.conf`. Relancer `kouziactl tailscale` (force `--accept-dns=false`) ou :

```bash
tailscale up --accept-dns=false
```

**kouzia.com / Revolut / Google cassés après Tailscale**  
`PUBLIC_API_ORIGIN` a été écrasé par une URL LAN ou `.ts.net`. Le remettre sur l'HTTPS Cloudflare. `kouziactl access` ne l'écrase plus s'il est déjà renseigné.

**Google Calendar : redirect vers une IP LAN injoignable en 4G**  
Le callback OAuth public reste `{PUBLIC_API_ORIGIN}/api/google/calendar/callback` (Cloudflare). Ensuite Kouzia redirige vers `WEB_ORIGIN`. Pour connecter Google **depuis le téléphone**, mets `WEB_ORIGIN` = MagicDNS, ou fais l'OAuth depuis le PC maison. Détail : `docs/google-calendar-setup.md`.

**Conflit avec Cloudflare Tunnel**  
Aucun, s'ils gardent leurs rôles : Tunnel = public (`127.0.0.1`), Tailscale = admin. Ne pas arrêter `cloudflared`.

**Funnel / Serve HTTPS**  
Hors scope. `tailscale funnel` publierait l'ERP sur Internet : à éviter.

## Références code

- CORS / origines : `apps/api/src/lib/env.ts` (`getAllowedOrigins`)
- Assistant CT : `scripts/alpine/configure.sh` (`configure_tailscale`)
- Menu : `kouziactl tailscale`
- Tunnel public : `kouziactl cloudflare`, `scripts/alpine/openrc/cloudflared`
