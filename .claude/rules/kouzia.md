# ERP Kouzia (propre à ce dépôt)

Le dépôt s'appelle encore `KouziaCRM`, mais l'outil est un ERP : clients, devis, factures, acomptes, paiements, abonnements, banque, obligations URSSAF, messagerie, agenda et espace client. Dans l'interface, la doc et les commits, on dit « ERP ». Migré depuis `.cursor/rules/open-source-first.mdc` et `typographie.mdc`. Les règles `web-*` s'appliquent avec les adaptations de la section « Règles web pour une application ».

## Charte (non négociable)

- Outil privé, mono-utilisateur, de l'EI Kouzia : micro-entreprise, franchise en base de TVA (art. 293 B du CGI), activité libérale non réglementée (BNC).
- Stack : API Fastify, Prisma et SQLite (`apps/api`, schéma `prisma/schema.prisma`) ; SPA Vite, React, TypeScript, Tailwind 4 et Font Awesome (`apps/web`) ; worker (`scripts/worker.ts`) pour la file d'e-mails et les tâches planifiées ; paquet partagé `packages/kouzia-forms`.
- Hébergement : Proxmox, CT Alpine (OpenRC, `scripts/alpine/`) ou Docker. L'administration reste privée (LAN ou Tailscale) et ne passe jamais par le tunnel Cloudflare. Seuls `/api/public/*` et les webhooks sont exposés sur `https://api.kouzia.com`.
- Le site `kouzia.com` (dépôt KouziaWebsite) lit l'API publique : invitation `/nouveau-client`, espace client `/suivi`. Tout changement de format d'une réponse `/api/public/*` se fait en accord avec ce dépôt et se documente dans son README.
- Configuration par `.env` uniquement, `.env.example` tenu à jour, aucun secret versionné.

## Invariants métier

- Montants en centimes entiers (`*Cents`), jamais en flottants. Pourcentages en points de base (`*Bps`).
- Un document émis (devis, facture, avoir) est immuable : numérotation continue sans trou ni réutilisation, attribuée à l'émission. Une erreur sur une facture émise se corrige par un avoir, jamais par une modification ou une suppression.
- Les PDF portent les mentions légales des réglages (TVA non applicable, SIRET, pénalités de retard, indemnité forfaitaire). Le contenu légal provient des réglages et des clauses légales, jamais du code en dur.
- Données personnelles des clients chiffrées au repos (`*Encrypted`, recherche par `emailHash`). Ne jamais les journaliser en clair.
- Preuve de signature d'un devis (`QuoteAcceptanceAudit`) : nom, source, date, IP, navigateur, PDF archivé et SHA-256. Ces données ne sont jamais modifiées.
- Zéro fiction : aucun avis, chiffre ou client inventé. Les avis affichés sur le site sont ceux validés dans l'ERP.

## Règles web pour une application

- `web-method`, `web-design`, `web-a11y`, `web-security`, `web-ui-states` : s'appliquent telles quelles.
- `web-code` : la SPA React est le choix assumé. La règle « utilisable sans JS » ne s'applique pas à l'admin. HTML sémantique, `button` pour une action et `a` pour une navigation restent obligatoires.
- `web-perf-eco` : pas de seuils de vitrine. Visent INP ≤ 200 ms et CLS ≤ 0,1, pages chargées en différé (`lazy`), aucun script ni police tiers depuis un CDN.
- `web-seo` : sans objet, sauf l'admin, qui ne doit jamais être indexée (`noindex`, `robots.txt` en `Disallow: /`).
- `web-legal` : RGPD sur les données clients (finalité, durée de conservation, droits). La politique de confidentialité publiée est celle de `kouzia.com`.

## Interface (UI/UX)

- Thème sombre unique (`color-scheme: dark`). Tokens dans `apps/web/src/index.css` (`:root`), seule source des valeurs brutes. Les composants utilisent `var(--*)`, jamais de couleur Tailwind en dur (`text-red-500`, `bg-slate-*`).
- Primitives communes dans `apps/web/src/components/ui/` (`Button`, `Card`, `Field`, `Modal`, `DataTable`, `ConfirmDialog`). Un besoin récurrent étend une primitive ; on ne recrée pas un bouton ou une carte dans une page.
- Responsive obligatoire : l'admin s'utilise aussi au téléphone (Tailscale). De 320 px au grand écran, sans scroll horizontal. Tableaux lisibles sur mobile, en cartes ou avec les colonnes essentielles. Cibles tactiles de 44 px minimum.
- Chaque écran prévoit les états chargement, vide, erreur et succès. Les actions destructrices passent par `ConfirmDialog`. Les retours d'action passent par `sonner`, sans `alert` ni `confirm` natifs.
- Libellés en français, vocabulaire métier constant : devis, facture, avoir, acompte, solde, jalon.

## Code

- Open source d'abord : avant d'écrire un utilitaire ou un composant de zéro, chercher une bibliothèque viable. Critères : licence permissive (MIT, Apache-2.0, BSD, ISC), maintenue, typée, légère. Sinon, écrire le code et noter pourquoi en une ligne de commentaire.
- Bibliothèques validées : `react-data-table-component` (tables), `cmdk` (palette), `sonner` (toasts), `recharts` (graphiques), `@react-pdf/renderer` (PDF), `zod` (validation), `argon2` (mots de passe), `node-cron`, `imapflow` et `nodemailer`, `vitest`.
- À ne pas introduire : AG Grid, MUI ou une autre bibliothèque de composants complète, TanStack Table.
- Toute entrée d'API est validée avec `zod`. Toute route admin commence par `requireAuth`. Les routes publiques ont une limite de débit et ne révèlent pas l'existence d'une donnée d'autrui (404 identique).
- Changement de schéma : une migration Prisma versionnée dans `prisma/migrations/`, jamais `db push` en production.
- Imports API avec l'extension `.js` (`@/lib/x.js`).

## Typographie

Interdits partout (code, interface, PDF, e-mails, commentaires, doc, migrations) : tiret cadratin (U+2014) et demi-cadratin (U+2013). Remplacer par `:`, `,`, `-`, des parenthèses ou une nouvelle phrase. Le tiret simple `-` reste autorisé.

## Terminé = vérifié

- Tests API : `cd apps/api && DATABASE_URL=file:./test.db npx prisma db push --skip-generate --accept-data-loss --schema=../../prisma/schema.prisma && DATABASE_URL=file:./test.db npx vitest run`. Sous Windows, `npm test` ne fonctionne pas (variable d'environnement en syntaxe Unix).
- Front : `npm run build -w @kouzia-erp/web` (`tsc -b` puis `vite build`) vert.
- UI : contrôle à 320, 768 et 1280 px, au clavier, puis skill `web-a11y-audit` sur les écrans touchés.
- Aucun U+2014 ni U+2013 introduit (`rg "[\x{2013}\x{2014}]" apps packages prisma scripts docs`).
- Ne jamais contourner un contrôle sans validation explicite. En fin de tâche, lister ce qui est vérifié, ce qui ne l'est pas, et la dette relevée (P0, P1, P2).
