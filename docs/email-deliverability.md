# Délivrabilité email (SPF, DKIM, DMARC)

Configurer ces enregistrements DNS sur le domaine utilisé dans `SMTP_FROM` (ex. `kouzia.fr`).

## SPF

Type: `TXT` · Nom: `@` (ou le domaine d'envoi)

```
v=spf1 include:mx.ovh.com -all
```

Adapter `include:` selon l'hébergeur SMTP (OVH, Google, Microsoft 365…).

## DKIM

Activer DKIM dans le panneau mail de l'hébergeur, puis coller le `TXT` fourni (souvent `selector._domainkey`).

## DMARC

Type: `TXT` · Nom: `_dmarc`

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@votredomaine.fr; pct=100; adkim=s; aspf=s
```

Passer à `p=reject` une fois les rapports stables.

## Checklist KouziaCRM

1. `SMTP_*` renseignés avec une adresse du domaine authentifié
2. `SMTP_FROM` aligné sur SPF/DKIM
3. Tester via Mailpit en local (`make mailpit`), puis un envoi réel vers une boîte externe
4. Vérifier sur https://www.mail-tester.com (cible ≥ 8/10)
