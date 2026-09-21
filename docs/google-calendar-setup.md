# Google Calendar : sync des obligations KouziaCRM

Guide pour créer le projet Google Cloud, activer l'API Calendar et configurer
le client OAuth Web. À faire **une seule fois** (gratuit pour un usage perso).

KouziaCRM pousse ensuite les échéances (URSSAF, CFE, impôts…) vers Google Agenda
avec des rappels téléphone (Samsung Calendar sync Google). Pas d'agenda dans l'ERP.

## Prérequis côté Kouzia

Domaine réel du projet : **`kouzia.com`** (Hostinger + Cloudflare Tunnel).
Ne pas inventer d'autres domaines (`.fr`, etc.).

| Rôle | URL |
|------|-----|
| Site public /suivi | `https://kouzia.com` (`PUBLIC_WEB_ORIGIN`) |
| API publique (webhooks, OAuth Google) | `https://api.kouzia.com` (`PUBLIC_API_ORIGIN`) |
| Admin ERP | `http://192.168.1.52:3000` (`WEB_ORIGIN`, LAN uniquement) |

### Créer le sous-domaine `api.kouzia.com` (une fois)

Oui : il faut **un** sous-domaine sous kouzia.com. Pas Zero Trust payant obligatoire
si ton tunnel Cloudflare existe déjà ; le hostname public du tunnel = `api.kouzia.com`.

1. **Cloudflare** (même compte que le tunnel) → Zero Trust / Tunnels → ton tunnel →
   **Public Hostname** :
   - Hostname : `api.kouzia.com`
   - Service : `http://127.0.0.1:3000`
   - Enregistrer (Cloudflare propose souvent le DNS automatiquement si le domaine
     est chez Cloudflare).

2. **Hostinger** (si le DNS de `kouzia.com` est encore géré dans hPanel) →
   **Domaines** → `kouzia.com` → **DNS / Zone DNS** → Ajouter :
   - Type : **CNAME**
   - Nom : `api`
   - Cible : celle indiquée par Cloudflare pour le tunnel
     (souvent `<id>.cfargotunnel.com`, ou laisse Cloudflare gérer le record
     si tu as délégué les nameservers).
   - TTL : défaut

3. Test :
   ```bash
   curl -sI https://api.kouzia.com/api/health
   ```
   Doit répondre **200**. Ensuite seulement : Google OAuth.

- API joignable à `PUBLIC_API_ORIGIN=https://api.kouzia.com` (**Pas** d'IP LAN, **pas** de `.ts.net`).
- Front admin : `WEB_ORIGIN` = l'URL LAN que tu tapes (`http://192.168.1.52:3000`).
  Après OAuth, Google revient sur `{PUBLIC_API_ORIGIN}/api/google/calendar/callback`,
  puis Kouzia redirige vers `{WEB_ORIGIN}/settings?tab=declarations`.
  Pour connecter Google **depuis le téléphone**, `WEB_ORIGIN` = MagicDNS Tailscale
  (voir `docs/tailscale-setup.md`). Sinon fais l'OAuth depuis le PC maison.
- Variables OAuth dans `.env` : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  (optionnel : `GOOGLE_REDIRECT_URI`).

URI de redirection **exacte** attendue par Kouzia :

```
{PUBLIC_API_ORIGIN}/api/google/calendar/callback
```

Exemples :

| Environnement | URI de redirection |
|---------------|--------------------|
| Prod | `https://api.kouzia.com/api/google/calendar/callback` |
| Local | `http://localhost:3001/api/google/calendar/callback` |

Tu peux enregistrer **les deux** URI sur le même client OAuth Web.

## 1. Créer le projet Google Cloud

1. Ouvre [Google Cloud Console](https://console.cloud.google.com/)
2. Sélecteur de projet (en haut) → **Nouveau projet**
3. Nom suggéré : `KouziaCRM` (ou `Kouzia Agenda`)
4. Créer, puis sélectionne ce projet

## 2. Activer l'API Google Calendar

1. Menu **APIs et services** → **Bibliothèque**
2. Cherche **Google Calendar API**
3. Ouvre la fiche → **Activer**

Sans cette étape, la connexion OAuth aboutit mais la sync des événements échoue.

## 3. Écran de consentement OAuth (Google Auth Platform)

Google a remplacé l'ancien écran unique à onglets. Aujourd'hui c'est
**APIs et services** → **Google Auth Platform** (parfois encore libellé
« Écran de consentement OAuth » dans le menu).

Si tu vois **Get started** / **Commencer** : lance le wizard une fois
(type **Externe**, nom `KouziaCRM`, ton Gmail).

Ensuite, trois pages séparées (menu de gauche Auth Platform) :

### 3a. Branding (identité)

- Nom de l'application : `KouziaCRM`
- E-mail d'assistance / contact développeur : ton Gmail
- Enregistrer

### 3b. Audience (qui peut se connecter) ← le plus important

1. Type d'utilisateurs : **Externe**
2. Statut de publication : laisser **Testing** / **Test** (pas In production)
3. Section **Test users** / **Utilisateurs de test** → **Add users** / **Ajouter**
4. Ajoute **ton adresse Gmail** (celle avec laquelle tu cliqueras « Connecter Google Agenda »)

Sans ton Gmail dans cette liste, Google affiche « Accès bloqué » / app non vérifiée
tant que le projet reste en Test. Publication en production Google **n'est pas**
nécessaire pour un usage solo.

### 3c. Data Access (scopes) ← plus un onglet « Champs d'application »

1. **Add or remove scopes** / **Ajouter ou supprimer des champs d'application**
2. Filtre ou coche :
   - `https://www.googleapis.com/auth/calendar.events`
     (créer / modifier / supprimer des événements Agenda)
   - `openid` et `…/auth/userinfo.email` (ou `email`)
     (afficher le compte connecté dans Paramètres → Fiscalité)
3. **Update** / **Mettre à jour** puis Enregistrer

Astuce : seuls les scopes des APIs **activées** apparaissent dans la liste.
Si `calendar.events` est absent, reviens à l'étape 2 (activer Google Calendar API),
ou colle l'URI du scope dans la zone « Manually add scopes » / ajout manuel.

Note : Kouzia demande déjà ces scopes au moment du bouton « Connecter ».
Les déclarer ici évite les surprises et prépare l'écran de consentement.
Publication / vérification Google reste inutile en mode Test + utilisateurs de test.


## 4. Créer le client OAuth « Application Web »

1. **APIs et services** → **Identifiants** → **Créer des identifiants** → **ID client OAuth**
2. Type d'application : **Application Web**
3. Nom : `KouziaCRM Web`
4. **URI de redirection autorisés** → Ajouter :
   - `https://api.kouzia.com/api/google/calendar/callback` (prod)
   - `http://localhost:3001/api/google/calendar/callback` (dev)
5. Créer
6. Copier :
   - **ID client** → `GOOGLE_CLIENT_ID`
   - **Secret client** → `GOOGLE_CLIENT_SECRET`

Ne jamais committer ces valeurs (uniquement `.env` local / secrets serveur).

## 5. Brancher KouziaCRM

Sur le CT Alpine (recommandé) :

```bash
kouziactl google
```

L'assistant demande `PUBLIC_API_ORIGIN` (**HTTPS Cloudflare**, jamais l'IP LAN),
affiche l'URI de redirection à coller **dans Google Cloud** (Identifiants →
client Web → URI de redirection autorisés), puis enregistre
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` et redémarre l'API.
Alias : `kouziactl agenda`.

Sinon, à la main dans `.env` :

```bash
PUBLIC_API_ORIGIN="https://api.kouzia.com"
# Dev local :
# PUBLIC_API_ORIGIN="http://localhost:3001"
# Jamais une URL Tailscale ni une IP LAN ici (webhooks + callback OAuth).

GOOGLE_CLIENT_ID="xxxxx.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-xxxxx"
# Optionnel si différent de {PUBLIC_API_ORIGIN}/api/google/calendar/callback :
# GOOGLE_REDIRECT_URI="http://localhost:3001/api/google/calendar/callback"

WEB_ORIGIN="http://192.168.1.52:3000"
# Prod téléphone Tailscale : WEB_ORIGIN="http://kouzia.tailnet-xxxx.ts.net:3000"
# Dev : WEB_ORIGIN="http://localhost:5173"
```

Redémarrer API + worker (`make dev` ou `kouziactl restart` en prod).

Puis dans l'ERP :

1. **Paramètres** → **Fiscalité**
2. Bloc **Google Agenda** → **Connecter Google Agenda**
3. Choisir le compte Gmail (celui ajouté en utilisateur de test)
4. Accepter les permissions Calendar
5. Au retour : toast « Google Agenda connecté » + email du compte affiché
6. (Optionnel) **Synchroniser maintenant** pour pousser les obligations ouvertes

Les emails de rappel (J-7, J-3, J-1, jour J) partent vers
`obligationReminderEmail` (défaut `kouziaeffa.pro@gmail.com`) via le worker horaire,
indépendamment de Google si SMTP est configuré.

## 6. Vérifications

| Contrôle | Attendu |
|----------|---------|
| Statut Fiscalité | « Connecté : ton@gmail.com » |
| Google Agenda (web ou Samsung) | Événement 9h Europe/Paris le jour de clôture, titre = label obligation |
| Rappels événement | J-7, J-3, J-1, à l'heure (9h) |
| Confirmation obligation dans Kouzia | Événement Google supprimé |
| Mailpit / boîte mail | Emails aux jalons si SMTP + toggle emails activés |

## Dépannage

**« Google Calendar non configuré »**  
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` absents ou API non redémarrée.

**redirect_uri_mismatch**  
L'URI dans Google Cloud doit être **identique** à celle utilisée par Kouzia
(`GOOGLE_REDIRECT_URI` ou `{PUBLIC_API_ORIGIN}/api/google/calendar/callback`).
Pas de slash final en trop, `http` vs `https` strict.
`PUBLIC_API_ORIGIN` = hostname Cloudflare, pas MagicDNS Tailscale.

**Accès bloqué / app non vérifiée**  
Compte Gmail pas dans **Audience → Test users**, ou mauvais projet sélectionné.
L'ancien onglet « Utilisateurs de test » n'existe plus : c'est la page **Audience**
du Google Auth Platform. Ne passe pas en « In production » pour un usage solo.
**Connecté mais pas d'événements**  
Calendar API non activée, ou worker / sync non passés : bouton **Synchroniser maintenant**.

**Aucun refresh token**  
Révoquer l'accès KouziaCRM dans
[https://myaccount.google.com/permissions](https://myaccount.google.com/permissions),
puis reconnecter (Kouzia demande `prompt=consent` + `access_type=offline`).

**DNS_PROBE_FINISHED_NXDOMAIN sur le hostname (ex. api.kouzia.com)**  
Le nom d'exemple de la doc n'existe pas automatiquement. Tu dois avoir un
**hostname public Cloudflare Tunnel** réel (Zero Trust → Tunnels → Public Hostname)
qui pointe vers `http://127.0.0.1:3000` sur le CT. Puis :
1. `PUBLIC_API_ORIGIN=https://TON-HOSTNAME` (celui qui répond dans le navigateur)
2. Même URI de redirect dans Google Cloud
3. `kouziactl restart` puis reconnecter Google

Test rapide : `curl -sI https://TON-HOSTNAME/api/health` doit répondre 200.
Si tu n'as pas encore de hostname API : `kouziactl cloudflare` + créer l'hostname
dans le panneau Cloudflare avant de retester OAuth.

**Après Google, le navigateur va sur une IP LAN injoignable**  
Le callback Cloudflare a réussi, puis Kouzia redirige vers `WEB_ORIGIN`.
En 4G, mets `WEB_ORIGIN` sur l'URL MagicDNS Tailscale, ou reconnecte Google depuis le PC maison.

**Changer de compte Google**  
Déconnecter dans Fiscalité, puis reconnecter avec l'autre compte (ajouter l'email en utilisateur de test si mode Testing).

## Références code

- Config / redirect : `apps/api/src/lib/google-calendar/config.ts`
- OAuth + tokens chiffrés : `apps/api/src/lib/google-calendar/oauth.ts`
- Routes : `apps/api/src/routes/google-calendar.ts`
- UI : Paramètres → Fiscalité (`SettingsPage.tsx`)
