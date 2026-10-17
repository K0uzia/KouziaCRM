# Kouzia ERP

ERP privé (gestion, facturation, suivi client) pour **Alexandre Kouziaeff** (EI Kouzia)  -  micro-entreprise, franchise en base de TVA (art. 293 B CGI), activité libérale non réglementée (BNC).

Stack : **Fastify + Prisma + SQLite** (API) · **Vite + React + TypeScript + Tailwind + Font Awesome** (SPA).

Hébergement cible : **Proxmox CT Alpine** (natif OpenRC) ou Ubuntu+Docker + **SQLite** + **Cloudflare Tunnel**.

## Prérequis

- Node.js 22+ (notifications push ; install et update s'arrêtent avant toute modification si Node est plus ancien)
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

**Migrations : écrites à la main.** Chaque changement de `schema.prisma` s'accompagne d'une migration SQL
versionnée dans `prisma/migrations/`, additive et relue (`ALTER TABLE … ADD COLUMN`, `CREATE INDEX`,
`UPDATE` ciblé). Ne jamais accepter les « RedefineTables » proposées par `prisma migrate dev` ou
`migrate diff` : la base (construite par migrations) diffère du schéma sur l'ordre des colonnes, quelques
valeurs par défaut et le type JSON (TEXT au lieu de JSONB), sans effet sur l'application, mais Prisma
voudrait reconstruire CompanySettings, Invoice, InvoiceLine, Payment et StripeWebhookEvent. Jamais de
`db push` sur une vraie base.

## Formulaire client public (Kouzia)

Flux :

1. Depuis l'ERP, invitation email (`POST /api/onboarding/invite`) : génère un token HMAC
   (`ONBOARDING_HMAC_SECRET`) et un enregistrement `OnboardingInvitation` (jti, expiration).
2. Le client ouvre `https://kouzia.com/nouveau-client/?token=...`.
3. Kouzia appelle `GET /api/public/clients/preview` puis `POST /api/public/clients`
   (CORS limité à `PUBLIC_WEB_ORIGIN`). Aucune donnée n'est stockée sur Kouzia.
4. L'ERP revalide adresse (BAN) et SIREN (recherche-entreprises), crée/met à jour le client.

### Portail client (suivi devis / acomptes)

Workflow : le client **valide d'abord le devis** (portail `/suivi` ou réponse email), puis reçoit le lien de paiement de l'acompte. La confirmation de paiement part après encaissement Stripe (webhook).

| Variable | Rôle |
|----------|------|
| `CLIENT_PORTAL_URL` | Lien `/suivi` inséré dans les emails (ex. `https://kouzia.com/suivi/`) |
| Dev local | `http://localhost:4321/suivi/` (site Kouzia Astro sur :4321, avec `PUBLIC_WEB_ORIGIN="http://localhost:4321"`) |

Variables à ajouter dans `.env` :

| Variable | Rôle |
|----------|------|
| `ONBOARDING_HMAC_SECRET` | Secret HMAC des liens (openssl rand -hex 32) |
| `ONBOARDING_TOKEN_TTL_DAYS` | Durée de validité (défaut 7) |
| `PUBLIC_WEB_ORIGIN` | Origine Kouzia (CORS + lien email) |
| `CLIENT_PORTAL_URL` | URL espace client `/suivi` (emails devis, paramètres ERP) |
| `VITE_PUBLIC_SITE_URL` | Redirection legacy `/onboarding/:token` |

#### Signature en ligne : CGV et droit de rétractation (contrat avec le site)

Le droit de rétractation des particuliers (client `B2C`, décidé par l'ERP, jamais par le site)
s'applique toujours : 14 jours à compter de la signature, prolongés au premier jour ouvrable si le
dernier tombe un samedi, un dimanche ou un jour férié (CGV art. 9). Sans demande d'exécution
anticipée, les travaux et la 1re période d'un abonnement attendent le lendemain du délai ; une
mise à jour du montant d'un abonnement déjà actif ne crée pas de nouveau délai. L'acceptation des
CGV, leur lien et leur version n'existent que si le réglage `cgvPublished` est vrai (Réglages >
Mentions légales).

`GET /api/public/tracking` ajoute :

| Champ | Contenu |
|-------|---------|
| `consumer` | `true` pour un particulier : afficher la case d'exécution anticipée. |
| `signatureTerms.cgv` | `{ url, version }` si les CGV sont publiées, sinon `null` (pas de case CGV). |
| `signatureTerms.expressExecutionText` | Libellé légal de la case (Réglages), `null` pour un professionnel. À afficher tel quel, jamais réécrit. |
| `documents[].withdrawal` | Devis signé par un particulier : `{ endsAt, expressExecution, startsNotBefore }` (`startsNotBefore` : null si l'exécution anticipée a été demandée). |

`POST /api/public/quotes/:id/decision` (`decision: "ACCEPT"`) accepte en plus :

| Champ | Règle |
|-------|-------|
| `acceptCgv` | `true`, obligatoire si `signatureTerms.cgv` n'est pas null (sinon 400 `CGV_REQUIRED`). |
| `cgvVersion` | Version affichée au client, obligatoire avec `acceptCgv` ; différente de la version en vigueur : 409 `CGV_VERSION_CHANGED` (recharger `/tracking`). |
| `expressExecution` | Facultatif, `false` par défaut. Particulier seulement : pour un professionnel, 400 `EXPRESS_EXECUTION_CONSUMER_ONLY`. |

Ces contrôles passent avant le code de signature : un refus ne le consomme pas. L'adresse des CGV
enregistrée vient des réglages, jamais du site. La preuve de signature (`QuoteAcceptanceAudit`)
fige `cgvAccepted`, `cgvUrl`, `cgvVersion`, `consumer`, `expressExecution` et
`withdrawalEndsAt` ; une signature hors espace client (e-mail, administration) est marquée « CGV
non acceptées en ligne ». Le PDF de tout devis d'un particulier porte le bloc « Droit de
rétractation » et le formulaire type (clause éditable dans Réglages > Clauses).

#### Rattachement aux projets (fiches projet de `/suivi`)

Ajouts facultatifs de `GET /api/public/tracking`, `null` quand rien n'est rattaché. Seuls les
projets visibles dans l'espace client (`visibleOnPortal`) du client connecté sont référencés : une
pièce d'un projet masqué porte `null`, jamais l'identifiant de ce projet.

| Champ | Contenu |
|-------|---------|
| `documents[].projectId` | Devis : son projet. Facture : projet de son devis (`quoteId`). Avoir : projet de la facture créditée. `null` sinon (devis en attente, pièce hors projet). |
| `paymentHistory.items[].projectId` | Jalon payé : projet de son devis. Règlement : projet de la pièce réglée. Avoir : comme `documents[]`. |
| `subscriptions[].projectId` | Projet de la ligne de devis (ou de facture) dont l'abonnement est issu ; `null` pour un abonnement saisi à la main. |
| `projects[].quoteId` | Devis d'origine du projet, `null` pour un projet créé à la main. |
| `projects[].startedAt` | Date de démarrage (ISO), `null` tant que le projet n'a pas démarré. |
| `projects[].kind` | `SITE`, `LOGICIEL`, `MAINTENANCE` ou `AUTRE` ; `null` si non renseigné (fiche projet de l'ERP, « Type de projet »). |

### Espace « Site » (contenu de kouzia.com)

Le contenu modifiable du site (coordonnées, accroche, offres, réalisations, FAQ, avis, références) se saisit dans l'ERP, puis se publie dans le dépôt KouziaWebsite (`src/content/site/*.json`, contrat `contenu.schema.json`).

- **Écrans** : bascule « Gestion / Site » en tête de la barre latérale (et du menu sur mobile) ; l'adresse `/site/*` décide de l'espace, qui a son propre accent (lavande). Vue d'ensemble (alertes et contrôle avant publication), Réalisations (fiche avec capture d'écran et capture de téléphone), Témoignages (adresse `/site/avis`), Références, FAQ (chaque question rattachée à une page, toutes reprises sur la page FAQ du site), Images (médiathèque), Coordonnées et réseaux, Accroche de l'accueil, Offres et tarifs, Connexion au dépôt (jeton, test, reprise).
- **Fiches et aperçu** : réalisations, témoignages, références et questions s'ouvrent en fiche (`/site/<écran>/<id>`, création par `/nouvelle` ou `/nouveau`), offres comprises : formulaire en onglets (reflétés dans `?tab=`, chaque onglet compte ses erreurs) et, à partir de 1024 px, aperçu de la carte de kouzia.com à côté, mis à jour à la frappe, en taille ordinateur ou téléphone (onglet « Aperçu » en dessous). L'aperçu recopie les composants du site (CarteProjet, Avis, MurLogos, ListeQuestions, OffreMaintenance) avec ses valeurs (fond nuit, accent ambre `--apercu-accent`, Exo 2, Share Tech Mono) : une évolution de ces composants dans KouziaWebsite se reporte dans `apps/web/src/pages/site/preview.tsx`.
- **Enregistrement automatique** : une fiche existante s'enregistre une seconde après la dernière frappe (« Enregistré à 14 h 32 »), un envoi à la fois ; les champs obligatoires sont vérifiés avant l'envoi et rien ne part tant qu'ils manquent. En quittant la fiche, ce qui reste part aussitôt ; le navigateur prévient avant de fermer un onglet non enregistré. Une création reste explicite (« Créer »). La mise en ligne reste le bouton Publier : un élément enregistré passe en « Modifié » jusqu'à la publication suivante.
- **Ordre** : « Réorganiser » sur les listes Réalisations, FAQ (page choisie) et Références : poignée à glisser à la souris ou au clavier (Espace pour prendre, flèches, Espace pour poser, Échap pour annuler), position annoncée au lecteur d'écran, boutons « Monter » et « Descendre » gardés à côté (téléphone). Chaque déplacement s'enregistre ; dans une liste filtrée, les éléments masqués gardent leur place. Bibliothèque : `@dnd-kit` (MIT).
- **Médiathèque** (`/site/images`) : toutes les images envoyées, filtrées par type ou « Non utilisées », recherche par nom, fichier ou fiche, envoi groupé par glisser-déposer (type choisi avant l'envoi). Chaque champ image d'une fiche peut aussi « Prendre dans la médiathèque ». Fiche d'une image : nom lisible (jamais publié), fiches qui l'utilisent, état en ligne, recadrage et suppression.
  - **Contrôle à l'envoi** : 15 Mo au plus par fichier ; le type se lit dans les premiers octets (JPEG, PNG, WebP, AVIF, SVG pour un logo), jamais dans l'extension, et le décodage par `sharp` doit trouver le même format. Un GIF ou un PDF renommé en `.png` est refusé.
  - **Original conservé** sous `site/originaux/` pour recadrer plus tard : orientation appliquée, **aucune métadonnée** (EXIF, position GPS des photos de téléphone, XMP), plus grand côté ramené à 4 000 px (JPEG ou WebP en qualité 92, PNG sans perte ; SVG tel quel, déjà contrôlé). Les images envoyées avant la médiathèque ou reprises du site n'ont pas d'original : les renvoyer pour pouvoir les recadrer.
  - **Recadrage** (captures d'écran et de téléphone ; un logo garde ses proportions) : point d'intérêt choisi sur l'original (clic ou curseurs au clavier), la zone publiée est montrée avant d'appliquer. Il produit une nouvelle version (nouvelle empreinte, donc nouvelle adresse `/media/`) et repointe les fiches qui l'utilisaient, qui passent en « Modifié ».
  - **Rien ne casse en ligne avant la publication suivante** : une image citée par la dernière publication arrivée dans le dépôt reste dans l'ERP (fichiers et fiche), même remplacée ou recadrée ; elle n'est pas supprimable. Les anciennes versions recadrées sont retirées automatiquement après la publication qui ne les cite plus. Une image se supprime seulement si aucune fiche ne l'utilise et qu'elle n'est plus en ligne : versions 1x et 2x, et l'original s'il n'est partagé avec aucune autre version. Site publié avant ce suivi : suppression refusée jusqu'à la prochaine publication.
  - **« Image absente de l'ERP »** (anomalie bloquante) : une fiche cite `/media/<empreinte>.webp` sans que l'ERP ait le fichier (base restaurée sans le dossier `data/uploads`, par exemple). La renvoyer avec « Remplacer » sur la fiche indiquée. La reprise initiale du site (Connexion au dépôt) copie elle-même les images publiées depuis `public/media/` du dépôt quand leur contenu correspond à leur nom.
- **Textes alternatifs** (contrat du site : `imageAlt`, `logoAlt`, facultatifs) : capture d'une réalisation (onglet Images) « Calculé par le site » (clé absente, le site garde son calcul `altCapture`, affiché en exemple), « Texte saisi » (200 caractères au plus) ou « Image décorative » (`imageAlt: ""`, alt vide) ; logo d'une référence : vide = nom de la structure, sinon le texte saisi (120 caractères au plus, jamais vide : c'est le nom du lien). La capture de téléphone reste décorative sur le site, sans champ. Un site en ligne plus ancien que ce contrat refuse ces clés : la publication est alors bloquée avec « … pas encore pris en charge par kouzia.com ; mettre le site à jour avant de publier, ou vider ce champ ».
- **Historique** (`/site/historique`, section Publication) : les 20 dernières publications, et pour chacune ce qu'elle a changé, comparé à la publication suivie précédente (fichiers gardés, voir la rétention des 50 dernières) : éléments ajoutés, modifiés champ par champ (« Avant » barré, « Après »), retirés, et changements d'ordre. Restaurer remet une version (celle publiée ici, ou celle d'avant) dans la fiche de l'ERP, ou la recrée en brouillon si elle a été supprimée, sans changer son statut ni sa place : rien ne part en ligne avant « Publier », où elle apparaît « Modifié ». Réalisations, références, questions et textes se restaurent ; un témoignage jamais (ses mots restent ceux publiés). Une image de la version restaurée absente de l'ERP est signalée (à renvoyer depuis la fiche).
- **Références sur le site** (sens fixé par KouziaWebsite c42e74b) : « Bandeau de l'accueil » et « Sous les réalisations, sur l'accueil » sont les deux emplacements choisis dans la fiche ; sur les pages Sites web et Logiciels, une référence apparaît d'elle-même si elle est liée à une réalisation de ce type. Une référence du mur de logos sans réalisation liée donne une alerte non bloquante dans le panneau Publier (section « À vérifier ») : elle n'apparaît alors que dans « Autres » sur l'accueil.
- **Textes des pages** (`/site/textes-pages`, fichier facultatif `pages.json`, lot 6 A) : titres et introductions des pages (Accueil, Sites web, Logiciels, À propos, FAQ), un onglet par page, enregistrement automatique, aperçu de la page choisie. Un champ vide garde le texte actuel du site, montré en exemple : ces textes viennent de `defauts.pages` du contrat (`contenu.schema.json` du dépôt, lu par `GET /api/site/textes-pages/defauts`, 10 min de cache), jamais recopiés dans l'ERP ; « Partir des textes actuels » remplit les champs vides pour retoucher plutôt qu'écrire. Variables `{ville}` (ville des réglages) et `{delaiReponse}` (coordonnées), remplacées dans l'aperçu comme au build du site ; un passage *entre astérisques* s'affiche en couleur, seulement dans le titre principal de l'accueil et le titre du bloc contact. Le fichier ne part que si le contrat du dépôt le déclare (site b2b331c et suivants).
- **Accroche de l'accueil** : le haut de l'accueil tel que le site l'affiche : surtitre et titre principal (h1, `pages.json`), introduction (`accroche.texte`, `textes.json`). Le titre de l'accroche (`accroche.titre`) n'est affiché nulle part sur le site : il n'est plus saisi et repart tel qu'il est enregistré (le contrat l'exige).
- **Réseaux facultatifs** (Coordonnées et réseaux, onglet « Réseaux et Google ») : GitHub, Instagram, fiche Google et lien « Laisser un avis Google » peuvent rester vides (« Laissez vide pour ne pas l'afficher sur le site. »). Un réseau vide est omis de `infos.json`, jamais envoyé en chaîne vide ; le site masque alors le lien (KouziaWebsite c6351fa). Un site plus ancien, qui les exige, bloque la publication avec la raison.
- **Images déjà dans le dépôt** : une réalisation peut pointer vers une image de `public/projets/` du site (chemin `/projets/nom.webp`), sans envoi. Leur aperçu ne s'affiche que depuis `erp.kouzia.com` (le site les sert en `Cross-Origin-Resource-Policy: same-site`).

- **Jeton GitHub** : fine-grained PAT limité au dépôt du site (Contents en lecture et écriture, Actions en lecture), saisi par `PUT /api/site/github`, chiffré en base et jamais renvoyé. `POST /api/site/github/test` le vérifie sans rien écrire et note sa date d'expiration.
- **Reprise initiale** : `POST /api/site/import` lit les 6 fichiers du dépôt et remplit un espace Site vide. Les accords des avis et des références ne sont pas dans le dépôt : à ressaisir avant de les republier.
- **Contrôles** : règles de la charte du site (liens https, jamais vers du code source, ni tiret cadratin ni demi-cadratin, identifiants uniques, accord avant publication), puis structure de `contenu.schema.json`.
- **État de publication** : chaque élément est Brouillon, Nouveau (jamais publié), Modifié, Publié, À retirer (publié puis retiré ou repassé en brouillon) ou Retiré, calculé dans l'ERP sans GitHub : à chaque publication arrivée dans le dépôt (commit ou NOOP), un élément prend l'empreinte de sa forme publiée (`publishedHash`, forme écrite dans `src/content/site/*.json` : un changement sans effet sur le site, comme un accord ou une note, ne le rend pas « Modifié ») et sa date de publication (`publishedAt`, qui fige l'identifiant et interdit la suppression). `GET /api/site/changes` liste ce qui partira à la prochaine publication (éléments, textes, ordre) et les anomalies bloquantes. Les fichiers publiés sont gardés sur la publication (`filesJson`, pour l'ordre et l'historique) : **rétention des 50 dernières publications**, `filesJson` vidé au-delà (quelques dizaines de Ko chacune). Contenu publié avant ce suivi : « Publié » jusqu'à la publication suivante, qui rétablit le détail.
- **Publication** : bouton « Publier » de la barre du haut dans tout l'espace Site, avec l'état (« En ligne », « 3 à publier », « Publication en cours », « Échec de publication ») et le nombre de changements ; il ouvre un panneau latéral (anomalies à corriger, changements groupés avec un lien vers chacun, dernière publication, « Mettre en ligne »). La carte Publication de la vue d'ensemble garde l'historique et ouvre le même panneau. Un seul commit Git Data sur `main` du site (fichiers modifiés seulement, images de l'ERP sous `public/media/`, `force: false`, 3 essais si la branche a bougé), aucun commit si rien ne change ; puis `repository_dispatch` « publication-site » vers l'Action de déploiement. Une seule publication à la fois (verrou libéré après 15 min). Suivi : rappel signé `POST /api/webhooks/site-deploy` (`SITE_DEPLOY_WEBHOOK_SECRET`, même valeur que `ERP_CALLBACK_SECRET` du site ; horodatage à 5 min, livraison unique), sinon état du run toutes les 15 s (worker), puis « En ligne » quand `kouzia.com/version.json` montre le commit ; alerte au-delà de 10 min. Run terminé sans rappel (secret du rappel absent côté site) : « Rappel non reçu : voir le run », verrou libéré aussitôt, `version.json` surveillé jusqu'aux 10 min. Le commit est fait pendant la requête : depuis `erp.kouzia.com`, une première publication avec beaucoup d'images peut dépasser la limite de 100 s de Cloudflare ; l'écran affiche alors une erreur, mais la publication continue et son suivi reprend dans l'historique. Jeton : Contents en écriture, Actions en lecture.
- **Témoignages** : déposés par les clients depuis `/suivi` quand un projet est terminé (`PUT` et `DELETE /api/public/portal/projects/:projectId/testimonial`, session du portail, un par projet, 600 caractères, accord versionné), ils arrivent « À valider » (cloche et push) ; Kouzia les publie tels quels ou les écarte avec un motif, communiqué à l'auteur (D111-19). Retrait possible à tout moment depuis `/suivi`. Preuve d'accord chiffrée ; l'IP et le navigateur en sont effacés 3 ans après le retrait ou l'écartement (worker, chaque heure). Aucune note ni étoile. L'e-mail de fin de projet propose un témoignage (lien de l'espace client) et un avis Google, à tous les projets terminés.
- **Images** : `sharp` (binaires précompilés, musl sur le CT Alpine). Sans lui, l'ERP démarre et seul l'envoi d'images est refusé.

### Paiements Stripe

Stripe encaisse (carte, virement, prélèvement SEPA) ; l'ERP reste seul émetteur des devis, factures et reçus. Les versements partent vers le Revolut Pro.

Réglages ERP : **Paramètres > Paiements** (interrupteur Stripe, clé secrète, secret webhook, tester, synchroniser le catalogue).

#### Réglages Stripe en prod

À régler dans le [tableau de bord Stripe](https://dashboard.stripe.com/), en **live** (et en test pour les essais). Ces réglages ne sont pas lisibles par l'API : l'ERP suppose l'état ci-dessous. Un e-mail activé à la fois chez Stripe et dans l'ERP arrive deux fois au client.

L'ERP envoie lui-même, depuis l'adresse d'envoi des Réglages : factures, échec de prélèvement (une fois par tentative), paiement régularisé, confirmation de paiement requise (3DS, rappels à J+3, J+5 et J+7 tant que la facture n'est pas payée), carte qui expire (vérification mensuelle de la carte par défaut, un e-mail par carte et par date d'expiration), abonnement suspendu faute de paiement, accusé de résiliation (programmée ou annulée) et information annuelle de reconduction.

**Après `kouziactl update` (déploiement de cette version), couper dans Stripe : cartes arrivant à expiration, lien hébergé de confirmation et ses rappels.** Avant ce déploiement, les laisser activés : l'ERP en production ne les envoie pas encore. Stripe envoie seul les avis préalables de prélèvement SEPA (obligatoires, non désactivables avec l'identifiant créancier de Stripe).

1. **Facturation > Abonnements et e-mails**
   - E-mails client : rappel de fin d'essai, renouvellements à venir, échec de paiement carte, échec de prélèvement bancaire, cartes arrivant à expiration **désactivés** (l'ERP s'en charge).
   - Événement `invoice.upcoming` : 7 jours avant le renouvellement (sans effet sur l'ERP : l'information légale de reconduction est planifiée par l'ERP, 45 jours avant la date limite).
   - Envoi des factures finalisées et des avoirs : **désactivé** (la facture légale est celle de l'ERP).
   - Confirmation de paiement (3DS) : « lien hébergé si confirmation nécessaire » et ses rappels **désactivés** (l'ERP envoie la page de la facture sur `invoice.payment_action_required`). Paiement non finalisé sous 15 jours : abonnement « non payé », facture laissée en l'état.
   - Mise à jour des moyens de paiement : page hébergée par Stripe.
   - Échecs : 1er échec d'un renouvellement, abonnement laissé en retard (`past_due`, badge « En retard » dans l'ERP) ; toutes les tentatives échouées, abonnement **non payé** (`unpaid` : « Suspendu, impayé » dans l'ERP, e-mail au client) ; facture laissée en retard. Prélèvement SEPA : aucune nouvelle tentative (l'e-mail d'échec n'en promet pas et invite à régulariser).
   - Litige ouvert : abonnement laissé en retard.
   - Factures `send_invoice` : e-mails désactivés, abonnement non payé à 30 jours, facture laissée en retard à 60 jours.
   - Mode de facturation : flexible.
2. **Entreprise > E-mails client** : reçus de paiement réussi et de remboursement **désactivés**.
3. **Portail client** (Facturation > Portail client), en test **et** en live, à l'identique :
   - Factures : activé ;
   - Informations client : désactivé (l'ERP reste la référence pour l'e-mail) ;
   - Moyens de paiement : activé ;
   - Annulations : activé, **en fin de période**, sans prorata, raison demandée ;
   - Abonnements (changer d'offre) : désactivé ;
   - Redirection : `https://kouzia.com/suivi/` ; politique de confidentialité : `https://kouzia.com/confidentialite/` ;
   - Lien sans code : désactivé ; portail nouvelle génération (bêta) : désactivé.

   L'ERP ouvre le portail sans imposer de configuration (celle par défaut s'applique), avec retour vers `/suivi`. Accès : bouton « Gérer mon abonnement » de `/suivi`, ou liens des e-mails. Les liens « Gérer mon abonnement » et « Régulariser le paiement » des e-mails (`/api/public/manage/…`) ouvrent ce portail, ou la page de paiement de l'échéance ouverte quand Stripe ne la retentera pas. Abonnement par virement : bouton « Demander la résiliation » de `/suivi` (accusé par e-mail au client, alerte à l'admin, badge « Résiliation demandée » dans Abonnements) ; l'admin clôture l'abonnement à la main.
4. Moyens de paiement : carte, prélèvement SEPA et virements bancaires (`customer_balance`).
5. Versements : rythme choisi, IBAN du compte pro déclaré.
6. Webhook vers `https://<votre-api>/api/webhooks/stripe` avec les événements : `payment_intent.succeeded`, `payment_intent.payment_failed`, `checkout.session.completed`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.marked_uncollectible`, `customer.subscription.updated`, `customer.subscription.deleted`, `product.*`, `price.*`, `payout.paid`, `payout.failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.

Une facture marquée non recouvrable dans Stripe reste émise et impayée dans l'ERP (badge « Non recouvrable », ni annulation ni avoir). Les factures d'abonnement prélevées par Stripe ne reçoivent jamais les relances de l'ERP.

Information annuelle de reconduction (Code de la consommation, L215-1) : pour chaque abonnement annuel (ERP ou Stripe), e-mail dédié 45 jours avant la date limite pour refuser la reconduction, date affichée dans un encadré. Date limite réglable dans **Paramètres > Rappels** (par défaut la veille du renouvellement).

Catalogue :

```bash
# Une fois : pousser le catalogue ERP actuel vers Stripe (test puis live)
npm run stripe:push-catalog
# Ensuite Stripe est la source de vérité ; sync horaire + bouton dans les réglages
```

Dev local avec la Stripe CLI :

```bash
stripe listen --forward-to localhost:3001/api/webhooks/stripe
# Coller le whsec_… affiché dans Paramètres > Paiements
```

## Terminé = vérifié

Avant un merge dans `main` :

| Contrôle | Commande |
|----------|----------|
| Tests API | `cd apps/api && DATABASE_URL=file:./test.db npx prisma db push --skip-generate --accept-data-loss --schema=../../prisma/schema.prisma && DATABASE_URL=file:./test.db npx vitest run` (sous Windows, `npm test` ne fonctionne pas) |
| Types et build du front | `npm run build` (lance aussi `check:lockfile`) |
| Lockfile | `npm run check:lockfile` : échoue si npm sous Windows a retiré les binaires des autres plateformes (dont `lightningcss-linux-x64-musl` pour le CT Alpine) |
| Mobile | `npm run check:mobile` (voir ci-dessous) |
| Hors ligne | `npm run check:offline` : réseau coupé (Playwright), changer d'écran ne recharge pas et ne renvoie pas vers /login, bandeau « Hors ligne » sans décalage, mesure `check:mobile` avec le bandeau. Sur l'origine du hors ligne (build de prod, `ADMIN_PUBLIC_ORIGIN` = `CHECK_OFFLINE_URL`, ex. `ADMIN_PUBLIC_ORIGIN=http://localhost:4173 npm run build` puis `vite preview`) : clients, devis et factures ouverts en ligne, puis rechargés hors ligne avec « Données du JJ/MM à HH h MM », et IndexedDB inspectée (magasins `cle`, `copies`, `file` et `relire` seulement, valeurs chiffrées, rien de /api en Cache Storage) ; puis, hors ligne, un client, un devis pour lui et une note créés, bandeau « Hors ligne · N à envoyer », écran « À envoyer » mesuré, et au retour du réseau chaque élément créé une seule fois (vérifié par l'API), « À envoyer » vide. Mêmes identifiants que `check:mobile` ; base de recette avec au moins un client, un devis et une facture (le contrôle y ajoute un client « Hors Ligne … » par largeur) |
| Front (unitaires) | `npm test -w @kouzia-erp/web` : `api()` hors ligne, `isStaleChunk`, copie chiffrée (aller-retour, liste fermée des exclusions, réseau puis copie, horodatage), file des créations hors ligne (chiffrement, ordre des dépendances, rejeu idempotent, session expirée, client supprimé, adresse déjà connue) |
| Chargement des pages | `npm run qa:mesure -- --width=360 --profil=4g-lent` : temps de Réglages, Clients, Factures et Messagerie (navigation et chargement complet), GET /api et appels en double ; profil 4G lent (RTT 150 ms, 1,6 Mbit/s, processeur x4) ou `bureau`. Mêmes identifiants que `check:mobile`, compte de recette sans double authentification, build de prod de préférence (`MESURE_URL`). |
| Typographie | aucun tiret cadratin ni demi-cadratin ajouté |

### Mode hors ligne (consultation et créations)

Sur l'origine `ADMIN_PUBLIC_ORIGIN` seulement (`erp.kouzia.com`, lue à l'exécution : l'API l'écrit dans `index.html` à chaque service de la page ; valeur du build à défaut). Ailleurs (Tailscale, LAN, dev), ni copie ni cache des écrans : le service worker ne sert qu'aux notifications push.

- Enveloppe : service worker `apps/web/sw/sw.ts` (push + Workbox) ; l'index et tous les fichiers des écrans en cache, toute page servie par `index.html` sauf `/api`. Nouvelle version : elle attend, un toast propose « Recharger ».
- Données : copie locale chiffrée (IndexedDB, AES-GCM 256, clé WebCrypto non extractible, IV de 12 octets par enregistrement) des seules lectures de `apps/web/src/lib/offline/rules.ts` : clients, prestations, devis, factures (sans paiements ni PDF) et le sous-ensemble des réglages utile aux devis. Réseau d'abord, copie ensuite ; un écran servi depuis la copie affiche « Données du JJ/MM à HH h MM » et ses actions d'écriture sont désactivées. Rien dans Cache Storage pour `/api`. Utilisateur courant (sans secret) gardé pour ouvrir l'ERP sans réseau ; la session du serveur fait foi dès son retour. Pas de code de déverrouillage, pas d'effacement automatique.
- Données copiées aussi : notes de rendez-vous et projets de la fiche client (liste blanche de champs). Hors ligne, les boutons d'action du corps des fiches sont désactivés avec l'explication, sauf les créations ci-dessous ; un montant non copié (encaissements) s'affiche « Consultable avec le réseau », jamais 0,00 €.
- Créations hors ligne (`apps/web/src/lib/offline/queue.ts`) : un client (même formulaire, champs minimaux, ni adresse, ni SIRET, ni e-mail d'accès, rien vers Stripe), un devis en brouillon pour un client existant ou préparé hors ligne (jamais émis, numéroté ni envoyé hors ligne), une note de rendez-vous (journal « Notes de rendez-vous » de la fiche, en ligne comme hors ligne). File chiffrée comme la copie (magasin `file`), sans cookie ni jeton ; chaque élément porte un UUID (`clientRequestId`) et sa date de préparation. Un devis ou une note pour un client préparé hors ligne attend sa création et prend son vrai identifiant.
- Envoi rejoué depuis la page (ouverture de l'ERP, retour du réseau, toutes les 30 s s'il reste à envoyer), session vérifiée d'abord, jamais par Background Sync ; session expirée : « Reconnectez-vous pour envoyer N éléments » (écran de connexion et « À envoyer »). API idempotente : un renvoi du même `clientRequestId` rend l'élément déjà créé (`POST /api/clients`, `POST /api/invoices`, `POST /api/clients/:id/notes`).
- Écarts : adresse e-mail déjà connue (`emailHash`), 409 `client_exists` sans doublon, devis et notes rattachés à la fiche existante et signalés ; fiche client modifiée depuis la préparation ou prix catalogue changé, brouillon créé tel que saisi (prix saisi gardé) avec l'étiquette « Préparé hors ligne, à relire » et son motif (`Invoice.offlineReviewReason`, visible sur tous les appareils : fiche et liste des devis), effacée par « Marquer comme relu » (`DELETE /api/invoices/:id/offline-review`) ou d'office à l'émission ; client supprimé ou donnée refusée, l'élément reste dans la file « à revoir ». Écran « À envoyer » (`/a-envoyer`, barre du haut, bandeau et menu) : liste, état, nouvel essai, suppression confirmée.
- Dépendances : `vite-plugin-pwa` (MIT, build du service worker et liste des fichiers à mettre en cache), `workbox-precaching`, `workbox-routing` et `workbox-window` (MIT, cache versionné des écrans et mise à jour en attente), `idb` (ISC, IndexedDB en promesses), `fake-indexeddb` (Apache-2.0, développement : IndexedDB pour les tests vitest).

### Contrôle mobile (`npm run check:mobile`)

Playwright (Chromium, dépendance de développement) parcourt tous les écrans de `navigation.ts`,
les onglets des Réglages, une fiche client, devis et facture, et les modales de création, à
320, 375 et 414 px. Il échoue sur un scroll horizontal, un élément sorti de son conteneur coupé ou de
l'écran, ou une cible d'action de moins de 44 px. Lecture seule : les modales sont ouvertes puis
fermées.

```bash
npx playwright install chromium        # une fois
npm run dev                            # sur une base de recette, jamais la prod
CHECK_MOBILE_EMAIL=… CHECK_MOBILE_PASSWORD=… CHECK_MOBILE_TOTP=… npm run check:mobile
```

`CHECK_MOBILE_TOTP` est le secret base32 du compte de test si sa double authentification est
active. Options : `CHECK_MOBILE_URL` (défaut `http://localhost:5173`), `CHECK_MOBILE_WIDTHS`
(défaut `320,375,414`), `CHECK_MOBILE_REPORT` (rapport JSON).

## Docker (app + worker + Prisma Studio)

```bash
docker compose up -d --build
```

| Service | Bind | Accès |
|---------|------|--------|
| App | `127.0.0.1:3000` | SPA + API |
| Worker |  -  | IMAP en IDLE (arrivée immédiate), repli chaque minute si IDLE est muet, file des e-mails toutes les 30 s |
| Prisma Studio | `127.0.0.1:5555` | SSH tunnel uniquement |

Volume persistant : `./data/kouziacrm.db` (sur l'hôte Proxmox, **pas dans l'image Docker**).

### Mise à jour après modification du code

```bash
bash scripts/deploy.sh
# équivalent : git pull && docker compose build app && docker compose up -d
```

- **Ne pas utiliser `--no-cache`** sauf dépannage (force un rebuild complet ~1 h sur petit CT).
- Le cache Docker réutilise `npm ci` tant que `package-lock.json` ne change pas.
- Une seule image (`kouzia-erp:latest`) sert app, worker et prisma-studio.
- **`docker compose down` ne supprime pas `./data`** (volume bind sur le disque hôte).
- **Ne jamais** `rm -rf data/` ni restaurer une vieille image par-dessus la base sans backup.

Premier build : long (npm + build SPA). Mises à jour code seul : quelques minutes (rebuild des layers `COPY . .` et build web uniquement).

## Déploiement Proxmox + Cloudflare Tunnel

### Recommandé : CT Alpine natif (sans Docker)

Léger, OpenRC, mises à jour sans rebuild complet, backup SQLite + rsync offsite.

Sur le CT Alpine 3.21+ (unprivileged OK) :

```bash
apk add bash git
git clone https://github.com/K0uzia/KouziaCRM.git /opt/kouziacrm
bash /opt/kouziacrm/scripts/alpine/kouziactl
# → menu : 1) Installer / réinstaller
```

Sans menu (non interactif) : `bash /opt/kouziacrm/scripts/alpine/install.sh --yes`

Puis :

1. Éditer `/opt/kouziacrm/.env` (`WEB_ORIGIN`, SMTP, IMAP).
2. Cloudflare Tunnel, deux *Public Hostnames* vers le même service `http://127.0.0.1:3000`
   (port `API_PORT` du CT, 3000 par défaut) :
   - `api.kouzia.com` : site public, webhooks, OAuth Google. Seules ces routes y répondent,
     le reste renvoie 404 ;
   - `erp.kouzia.com` : administration (`ADMIN_PUBLIC_ORIGIN="https://erp.kouzia.com"` dans `.env`),
     accessible seulement avec la double authentification activée (voir « Double
     authentification » ci-dessous).
3. Optionnel : `kouziactl tailscale` pour l'admin depuis le téléphone
   ([guide](docs/tailscale-setup.md)).
4. Optionnel : `/etc/kouzia/rsync.env` pour pousser les backups chiffrés hors du CT.

| Commande | Rôle |
|----------|------|
| `kouziactl` / menu | Install, config, update, backup… |
| `kouziactl configure` | Assistant complet |
| `kouziactl access` / `admin` / `site` / `mail` / `cloudflare` / `tailscale` / `rsync` | Reconfigurer une section seule |
| `kouziactl summary` | Affiche IP LAN, URL, status |
| `kouziactl update` | Update incrémental, puis nouveautés de config si encore vides |
| `kouziactl new-config` | Proposer les sections nouvelles (ex. Tailscale) sans update |
| `kouziactl update --git` | `git pull` + update |
| `./scripts/alpine/deploy-rsync.sh user@ct` | Depuis le PC : rsync code + update distant |
| `kouziactl backup` / `restore` | Backup GPG + rsync / restore |

Détails : `scripts/alpine/` (install, update, backup, restore, OpenRC, conf rsync).

**Services OpenRC (`kouziacrm`, `kouziacrm-worker`).** Lancés par `supervise-daemon` : un
processus qui s'arrête (crash, exception non gérée) est relancé après 5 s, 10 fois au plus par
fenêtre de 60 s. Au-delà, le service reste arrêté et `kouziactl status` l'affiche (`crashed` ou
`stopped`) : lire `kouziactl logs app` ou `logs worker` et `/var/log/kouzia/*.err`, corriger, puis
`kouziactl restart`. Journaux inchangés : `/var/log/kouzia/app.log|.err` et `worker.log|.err`.
`kouziactl update` réinstalle les scripts de `scripts/alpine/openrc/` quand ils ont changé, après
avoir arrêté la pile avec les scripts en place (aucun processus orphelin d'une ancienne version).
Recette : `kouziactl selftest-respawn worker` (ou `app`) tue le processus node du service, jamais
le superviseur, et vérifie la relance. Ne pas viser le processus avec `pgrep -f "tsx.*worker.ts"` :
la ligne de commande de `supervise-daemon` contient les mêmes arguments. Service affiché
`unsupervised` (superviseur tué, processus orphelin) : `kouziactl repair-service worker` (ou `app`).

### Double authentification (admin par Internet)

Par le tunnel, l'administration (`erp.kouzia.com`) demande le mot de passe puis un code à
6 chiffres (TOTP, Google Authenticator ou équivalent). Tant que la double authentification n'est
pas activée, la connexion par Internet est refusée : l'activation se fait donc depuis le réseau
local ou Tailscale.

1. Se connecter à l'admin en LAN (`http://IP_DU_CT:3000`) ou par Tailscale.
2. Réglages > Sécurité > « Activer la double authentification ».
3. Scanner le QR code avec l'application (ou saisir la clé), puis entrer le code affiché.
4. Enregistrer les 10 codes de secours (télécharger ou copier), hors de l'ordinateur. Chacun ne sert
   qu'une fois ; Réglages > Sécurité permet d'en créer de nouveaux avec un code de l'application.
5. Les autres sessions sont fermées. La connexion par `https://erp.kouzia.com` est désormais possible.

Une connexion depuis un nouvel appareil envoie un email d'alerte au compte admin. Après 5 échecs
venus d'Internet, le compte est verrouillé 15 minutes pour Internet (le LAN reste utilisable).

Téléphone et codes de secours perdus : sur le CT, en root,

```bash
kouziactl 2fa-reset admin@kouzia.com
```

désactive la double authentification et ferme toutes les sessions. Reprendre ensuite à l'étape 1,
et changer le mot de passe si l'appareil a été perdu ou volé.

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

### Ordre de déploiement (ERP et site kouzia.com)

Le site (dépôt KouziaWebsite) lit `/api/public/*`. Quand une version change le format d'une réponse ou d'une entrée publique, l'ordre compte :

| Version (merge) | Ordre | Raison |
| --- | --- | --- |
| 57dd4db, gestion des abonnements dans /suivi | site **avant** `kouziactl update` | `/api/public/tracking` renvoie aussi les abonnements suspendus ; l'ancien /suivi les afficherait comme actifs. |
| Type client « Association » (à venir) | `kouziactl update` **avant** le site | le nouveau formulaire /nouveau-client envoie `ASSOCIATION`, refusé (400) par un ERP plus ancien. |

Une nouvelle version concernée s'ajoute à ce tableau.

## Backup & restore

Le backup utilise l'API SQLite (`.backup`) qui gère correctement le mode WAL,
contrairement à un `cp` brut qui peut produire un fichier incohérent.

**Pièces archivées.** Les PDF de référence sont des fichiers sous `data/uploads`, inclus dans la
sauvegarde (archive chiffrée `kouziacrm-<date>.uploads.tar.gz.gpg`, restaurée par
`kouziactl restore --uploads …`) :

- `signed-quotes/` : devis tels qu'acceptés (avant et après signature, SHA-256 sur la preuve) ;
- `issued-documents/` : factures et avoirs, rendus une fois à l'émission (SHA-256 sur le document),
  puis servis tels quels (téléchargement, `/suivi`, pièce jointe des e-mails). Modifier un réglage ou
  une clause ne change plus le PDF d'un document émis. Le worker archive toutes les heures ce qui
  manquerait.
- `receipts/` : reçu de chaque règlement (montant, moyen, reste dû, « facture acquittée » quand elle est
  soldée), archivé à l'envoi de l'e-mail « Paiement reçu » ou au premier accès (`/suivi`). La facture émise ne
  change pas avec les paiements : c'est le reçu qui atteste le règlement.
- `site/` : images de l'espace Site (captures et logos de kouzia.com), en WebP normalisé sans
  métadonnées (`<empreinte>.webp`, et `<empreinte>-2x.webp` si la source est assez grande). `site/originaux/` :
  original de chaque image, réécrit sans métadonnées et borné à 4 000 px (quelques Mo au plus), pour recadrer ;
  le fichier envoyé tel quel n'est jamais gardé.

Après la mise à jour qui introduit l'archivage, lancer une fois `kouziactl archive-pdfs` : les factures et
avoirs déjà émis sont archivés avec les réglages du moment (sans effet sur ceux déjà archivés).

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

## Documentation ops

- [Délivrabilité email (SPF / DKIM / DMARC)](docs/email-deliverability.md)
- [Google Calendar : projet Cloud, API, OAuth Web](docs/google-calendar-setup.md)
- [Tailscale : admin ERP depuis le téléphone](docs/tailscale-setup.md)

## Sécurité

- Sessions **serveur** (table `Session`) + cookie `httpOnly` / `SameSite=Lax`
- Mots de passe **argon2id** (migration auto depuis bcrypt au login)
- Rate-limit login, Helmet, contrôle Origin sur mutations
- PII clients (email / téléphone / SIRET) : AES-256-GCM (`ENCRYPTION_KEY`), ainsi que l'adresse du journal des e-mails envoyés, celle des invitations et le contenu de la file d'envoi (migration 20261109090000 ; recopie chiffrée des lignes antérieures par le worker, suspendue sans rien vider si la clé est absente ou différente de celle des données)

- Choix assumés (audit d'octobre 2026) :
  - CSP `img-src` garde `https:` : la messagerie affiche les images distantes des e-mails reçus (option pour les bloquer par message). Risque accepté : un pixel de suivi d'un expéditeur peut savoir qu'un message a été ouvert. `font-src` est limité aux polices locales.
  - Par le tunnel, sans double authentification activée, un mot de passe juste reçoit le refus explicite « activez la double authentification » (403) : il confirme que le mot de passe est bon, mais la connexion reste impossible sans 2FA. Risque jugé faible, gardé pour la clarté.
- `ONBOARDING_HMAC_SECRET` : obligatoire en production ; `kouziactl update` le génère s'il est absent ou vaut encore une valeur d'exemple (ligne dans le journal de la mise à jour).

### Conservation des données (RGPD)

Purge par le worker, chaque heure (`apps/api/src/lib/privacy/retention.ts`). Les pièces comptables
(devis, factures, avoirs, paiements) et les clients qui en ont ne sont jamais supprimés.

| Donnée | Durée | Ce qui part |
|--------|-------|-------------|
| Prospect sans suite | 3 ans après le dernier contact (référentiel CNIL) | La fiche, seulement sans aucun document (même brouillon), abonnement, projet, avis ni témoignage, et sans e-mail ni fil de messagerie depuis 3 ans |
| Invitation (`/nouveau-client`) | 30 jours après son expiration ou son utilisation | La ligne |
| File d'envoi des e-mails | 30 jours après l'envoi | Le contenu (destinataire, texte, pièces jointes) ; la ligne reste (date, état) |
| Journal des e-mails envoyés à un client | 1 an | La ligne |
| Session admin | 7 jours au plus, 24 h sans activité | La ligne |
| Espace client | Codes : 1 jour après expiration ; sessions : 1 an après leur fin (journal des connexions) | Les lignes |
| Preuve d'accord d'un témoignage | 3 ans après retrait ou écartement | L'IP et le navigateur |
| Messagerie (`EmailMessage`) | Aucune purge propre | Miroir de la boîte IMAP : un message supprimé de la boîte disparaît de l'ERP à la synchronisation |

## Makefile

| Commande | Description |
|----------|-------------|
| `make setup` | `.env`, install, migrations, seed |
| `make dev` | Ports libres, dépendances conformes au lockfile (sinon `npm ci` automatique, jamais `npm install`), migrations, puis Mailpit + API + Vite en parallèle |
| `make mailpit` / `make mailpit-stop` | SMTP catcher local (UI :8025) |
| `make app` | Build web + API qui sert la SPA |
| `make worker` | Worker : IMAP en IDLE avec repli chaque minute, file des e-mails, tâches planifiées |
| `make db-deploy` / `make db-seed` | Base |
| `make alpine-deploy HOST=user@ct` | Rsync + update incrémental vers CT Alpine |
| `make alpine-status HOST=user@ct` | Status distant |

## Conformité MVP

- Numérotation configurable par série (défaut `F-{year}-{counter}` → ex. `F-2026-0001`), allouée à l'émission uniquement
- Pas de suppression de facture  -  avoir
- Mentions PDF franchise TVA art. 293 B
- Enveloppes sur CA encaissé

## Dette connue

- P2, branche dédiée `chore/montants-centimes` (avec tests de bout en bout) : plusieurs écrans envoient encore des montants en euros (`amountEuros`, `unitPriceEuros`, `discountEuros`, `cfeAmountEuros`), convertis en centimes par l'API (`eurosToCents`, arrondi décimal exact à 2 chiffres). La charte veut des `*Cents` entiers de bout en bout : contrat front et API à basculer d'un bloc.
- P2, performance, à surveiller si les volumes montent (sans effet mesurable sur la base de production actuelle, 1,1 Mo) :
  - flux des notifications (`lib/notifications/feed.ts`, relevé toutes les 30 s) : filtres sur des colonnes sans index (`EmailMessage.createdAt`, `Payment.createdAt`, `QuoteAcceptanceAudit.createdAt`, `PaymentMilestone.triggeredAt`, `Subscription.stripeStatusChangedAt`, `Client.onboardingCompletedAt`), donc parcours complets ;
  - `getOwnerPaySummary` (`lib/finance/owner-pay.ts`) et `/api/stripe/flux` (`lib/finance/stripe-flux.ts`) lisent tous les paiements (et versements) puis les reparcourent pour chaque mois : coût en mois × paiements ;
  - `listDeposit2Todos` (`lib/quotes/payment-plans.ts`) filtre `Invoice.paymentPlan`, sans index, après les autres blocs du tableau de bord ;
  - `ensureDefaultLegalClauses` (`lib/company/legal-clauses.ts`) fait une requête par clause par défaut à chaque lecture des clauses (`LegalClause.title` sans index).
  Mesure : `npm run qa:mesure -- --pages="Tableau de bord,Réglages" --detail` (temps et poids de chaque route).

## Identité seedée

- SIREN `108580028` / SIRET `10858002800018`
- 13 Le Petit Moulin, 29690 Huelgoat
- Nom commercial : Kouzia
