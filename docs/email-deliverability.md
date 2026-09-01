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

## Checklist KouziaCRM

1. Paramètres > Emails & Messagerie : SMTP Hostinger (`smtp.hostinger.com:465` SSL) + IMAP (`imap.hostinger.com:993`)
2. Mot de passe boîte `contact@kouzia.com` enregistré (chiffré en base)
3. Boutons « Tester l'envoi » et « Tester IMAP »
4. En local : Mailpit (`make mailpit`) via `.env` tant que les Paramètres SMTP ne sont pas enregistrés
5. Vérifier sur https://www.mail-tester.com (cible ≥ 8/10)
