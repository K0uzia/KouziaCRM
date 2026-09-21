# Google Calendar : sync des obligations KouziaCRM

Guide pour créer le projet Google Cloud, activer l'API Calendar et configurer
le client OAuth Web. À faire **une seule fois** (gratuit pour un usage perso).

KouziaCRM pousse ensuite les échéances (URSSAF, CFE, impôts…) vers Google Agenda
avec des rappels téléphone (Samsung Calendar sync Google). Pas d'agenda dans l'ERP.

## Prérequis côté Kouzia

- API joignable à une URL **HTTPS publique** (Cloudflare Tunnel) : `PUBLIC_API_ORIGIN`
  (ex. `https://gestion.kouzia.fr`). **Pas** une IP LAN, **pas** une URL Tailscale (`.ts.net`).
- Front admin : `WEB_ORIGIN` = l'URL que tu tapes dans le navigateur (LAN ou MagicDNS Tailscale).
  Après OAuth, Google revient sur `{PUBLIC_API_ORIGIN}/api/google/calendar/callback` (Cloudflare),
  puis Kouzia redirige vers `{WEB_ORIGIN}/settings?tab=declarations`.
  Pour connecter Google **depuis le téléphone**, `WEB_ORIGIN` doit être l'URL Tailscale
  (voir `docs/tailscale-setup.md`). Sinon fais l'OAuth depuis le PC maison.
- Variables à renseigner dans `.env` après création du client OAuth :
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - optionnel : `GOOGLE_REDIRECT_URI` (sinon dérivé de `PUBLIC_API_ORIGIN`)

URI de redirection **exacte** attendue par Kouzia :

```
{PUBLIC_API_ORIGIN}/api/google/calendar/callback
```

Exemples :

| Environnement | URI de redirection |
|---------------|--------------------|
| Prod | `https://gestion.kouzia.fr/api/google/calendar/callback` |
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

## 3. Écran de consentement OAuth

1. **APIs et services** → **Écran de consentement OAuth**
2. Type d'utilisateur : **Externe** (compte Gmail perso) → Créer
3. Remplir le minimum :
   - Nom de l'application : `KouziaCRM`
   - E-mail d'assistance utilisateur : ton Gmail
   - E-mail de contact développeur : ton Gmail
4. Enregistrer
5. Onglet **Champs d'application (Scopes)** → Ajouter :
   - `https://www.googleapis.com/auth/calendar.events` (créer / modifier / supprimer des événements)
   - `openid` et `email` (affichage du compte connecté dans Paramètres)
6. Onglet **Utilisateurs de test** → **Ajouter des utilisateurs** → ton adresse Gmail
   (obligatoire tant que l'app est en mode **Test** ; sinon « Accès bloqué »)
7. Revenir au résumé → laisser le statut **Testing** (suffisant pour un usage solo)

Publication en production Google n'est pas nécessaire pour un usage personnel avec utilisateurs de test.

## 4. Créer le client OAuth « Application Web »

1. **APIs et services** → **Identifiants** → **Créer des identifiants** → **ID client OAuth**
2. Type d'application : **Application Web**
3. Nom : `KouziaCRM Web`
4. **URI de redirection autorisés** → Ajouter :
   - `https://gestion.kouzia.fr/api/google/calendar/callback` (prod)
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

L'assistant demande `PUBLIC_API_ORIGIN`, affiche l'URI de redirection à coller
dans Google Cloud, puis enregistre `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
et redémarre l'API. Alias : `kouziactl agenda`.

Sinon, à la main dans `.env` :

```bash
PUBLIC_API_ORIGIN="https://gestion.kouzia.fr"
# Dev local :
# PUBLIC_API_ORIGIN="http://localhost:3001"
# Jamais une URL Tailscale ni une IP LAN ici (webhooks + callback OAuth).

GOOGLE_CLIENT_ID="xxxxx.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-xxxxx"
# Optionnel si différent de {PUBLIC_API_ORIGIN}/api/google/calendar/callback :
# GOOGLE_REDIRECT_URI="http://localhost:3001/api/google/calendar/callback"

WEB_ORIGIN="https://gestion.kouzia.fr"
# Prod LAN : WEB_ORIGIN="http://192.168.1.50:3000"
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
Compte Gmail pas dans **Utilisateurs de test**, ou mauvais projet sélectionné.

**Connecté mais pas d'événements**  
Calendar API non activée, ou worker / sync non passés : bouton **Synchroniser maintenant**.

**Aucun refresh token**  
Révoquer l'accès KouziaCRM dans
[https://myaccount.google.com/permissions](https://myaccount.google.com/permissions),
puis reconnecter (Kouzia demande `prompt=consent` + `access_type=offline`).

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
