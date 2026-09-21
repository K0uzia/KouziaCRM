# Google Calendar : sync des obligations KouziaCRM

ERP en LAN (CT) + site `kouzia.com` à part. Login Google = **une fois**.
Pas de sous-domaine, pas de DNS Hostinger.

## Checklist (3 endroits)

### A) CT : tunnel jetable (laisser ouvert)

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Noter l’URL, ex. `https://xxxx.trycloudflare.com`.

Autre terminal :

```bash
curl -4 -sI --connect-timeout 10 https://xxxx.trycloudflare.com/api/health
```

→ **200**.

### B) Google Cloud (navigateur)

| Où | Quoi |
|----|------|
| Bibliothèque | Activer **Google Calendar API** |
| Auth Platform → Audience | Externe, **Testing**, ton Gmail en **Test users** |
| Auth Platform → Data Access | scopes `calendar.events` + `openid` + `email` (si demandé) |
| Identifiants → client **Application Web** | URI de redirection = ci-dessous |
| Identifiants | Copier **ID client** + **Secret** |

URI de redirection (**exacte**, même host que A) :

```text
https://xxxx.trycloudflare.com/api/google/calendar/callback
```

### C) CT : Kouzia

**Sans** attendre le nouveau script (si CT pas encore à jour), édite `/opt/kouziacrm/.env` :

```bash
GOOGLE_CLIENT_ID="….apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-…"
GOOGLE_REDIRECT_URI="https://xxxx.trycloudflare.com/api/google/calendar/callback"
```

Ne **change pas** `PUBLIC_API_ORIGIN` / `WEB_ORIGIN`.

```bash
rc-service kouziacrm restart
```

Ou, après update du script : `kouziactl google` (demande les 3 mêmes champs).

### Navigateur

1. `http://192.168.1.52:3000/settings?tab=declarations`
2. **Connecter Google Agenda** → compte test → autoriser
3. Toast « connecté »
4. Ctrl+C sur le tunnel A

Le CT garde le refresh token : plus besoin de tunnel pour la sync quotidienne.

## Dépannage court

| Symptoôme | Cause |
|-----------|--------|
| redirect_uri_mismatch | URI Google ≠ `GOOGLE_REDIRECT_URI` (caractère près) |
| Accès bloqué | Gmail pas en Test users |
| Callback timeout | Tunnel A fermé trop tôt |
| « Google non configuré » | ID/secret absents ou API pas restart |

## Après connexion

Paramètres → Fiscalité → **Synchroniser maintenant** (optionnel).
Emails de rappel J-7/J-3/J-1 : SMTP + worker, indépendants de Google.
