# Délivrabilité email (SPF, DKIM, DMARC)

Configurer ces enregistrements DNS sur le domaine utilisé dans l'adresse d'expédition
(Paramètres > Emails & Messagerie, ex. `contact@kouzia.com` / domaine `kouzia.com`).

Hébergeur mail : **Hostinger** (hPanel > Emails).

## SPF

Type: `TXT` · Nom: `@` (ou le domaine d'envoi)

```
v=spf1 include:_spf.mail.hostinger.com ~all
```

## DKIM

Dans hPanel > Emails, activer DKIM puis coller l'enregistrement `TXT` fourni
(souvent `selector._domainkey`).

## DMARC

Type: `TXT` · Nom: `_dmarc`

Phase 1 (observation) :

```
v=DMARC1; p=none; rua=mailto:contact@kouzia.com
```

Une fois les rapports stables, renforcer vers `p=quarantine` puis `p=reject`.

## Checklist Kouzia ERP

1. Paramètres > Emails & Messagerie : SMTP Hostinger (`smtp.hostinger.com:465` SSL) + IMAP (`imap.hostinger.com:993`)
2. Mot de passe boîte `contact@kouzia.com` enregistré (chiffré en base)
3. Boutons « Tester l'envoi » et « Tester IMAP »
4. En local : Mailpit (`make mailpit`) via `.env` tant que les Paramètres SMTP ne sont pas enregistrés
5. Vérifier sur https://www.mail-tester.com (cible ≥ 8/10)

## Expéditeur des e-mails automatiques (noreply@)

Les e-mails automatiques (codes de connexion et de signature, invitation à compléter sa fiche,
accès à l'espace client, alertes de connexion) peuvent partir d'une adresse dédiée, par exemple
`noreply@kouzia.com`, avec un Reply-To vers `contact@kouzia.com`. Les documents (devis, factures,
reçus) et les échanges restent sur `contact@kouzia.com`.

Réglage : Paramètres > Emails > « Expéditeur des e-mails automatiques ». Vide : tout part de
l'adresse habituelle.

Chez Hostinger, le serveur SMTP est authentifié avec `contact@kouzia.com` ; un alias de cette boîte
devrait être accepté en expéditeur (à vérifier par l'essai de l'étape 2) :

1. hPanel > Emails > `contact@kouzia.com` > Alias : créer `noreply@kouzia.com` comme alias de
   `contact@`. Aucune boîte ni mot de passe supplémentaire, aucun changement de réglage SMTP.
2. Envoyer un e-mail de test depuis l'ERP (par exemple une invitation à sa propre adresse) et
   vérifier l'expéditeur reçu.
3. Si le serveur refuse l'alias en expéditeur (erreur 550 ou 553), l'ERP renvoie automatiquement
   l'e-mail depuis `contact@kouzia.com` (journal : « expéditeur transactionnel refusé ») : rien
   ne se perd. Dans ce cas, garder le réglage vide, ou créer une vraie boîte `noreply@` (évolution
   à prévoir : identifiants SMTP distincts).

SPF, DKIM et DMARC : rien à changer. L'adresse est sur le même domaine et part des mêmes serveurs
Hostinger : SPF (`include:_spf.mail.hostinger.com`) et la signature DKIM du domaine `kouzia.com`
restent alignés, DMARC passe.

Tous les envois de l'ERP portent l'en-tête `X-Kouzia-Outbound: 1` et un Message-ID
`<…@kouzia.local>` : la synchro IMAP les reconnaît s'ils réapparaissent dans la boîte de
réception, sans notification « nouvel e-mail » ni non lu.
