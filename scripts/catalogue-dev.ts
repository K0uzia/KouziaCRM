// Catalogue de l'ERP de DÉVELOPPEMENT aligné sur celui de la production (captures du 19/10/2026 : 12 services,
// 6 packs avec leur contenu, 5 options, 6 abonnements annuels). Lancé par Alexandre lui-même : npm run catalogue:dev.
// Idempotent : crée ou met à jour par nom EXACT, n'efface rien (ni prestation, ni contenu de pack en trop).
// Aucun appel à Stripe : les prestations sont écrites dans la base locale seulement, sans identifiant Stripe.
// Refuse de tourner en production : NODE_ENV=production, clé Stripe live dans les réglages, ou prestation liée à
// Stripe en mode live (signe d'une base de production copiée).
// Options : --oui (sans demande de confirmation), --tout-compris (ajoute les 4 abonnements « tout compris »).
import { createInterface } from "node:readline/promises";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { detectStripeMode } from "@/lib/stripe/client.js";

type Item = {
  name: string;
  description: string | null;
  euros: number;
  kind: "ONE_OFF" | "PACK" | "YEARLY";
  /** SITE, LOGICIEL, OPTION ; null : non classée (packs, abonnements, ou rubrique inconnue). */
  category: "SITE" | "LOGICIEL" | "OPTION" | null;
  /** Pack : noms exacts des prestations qu'il contient, dans l'ordre affiché. */
  contents?: string[];
};

// Onglet Services (capture 017). Les deux prestations à 700 € sont reproduites telles quelles (doublon signalé).
const SERVICES: Item[] = [
  { name: "Automatisation entre outils", description: "Relier deux outils (tableur, agenda, caisse, site) pour supprimer une saisie répétée.", euros: 500, kind: "ONE_OFF", category: "LOGICIEL" },
  { name: "Boutique en ligne (50 produits)", description: "Catalogue jusqu'à 50 produits, panier, paiement en ligne sécurisé, gestion des commandes, mentions légales et CGV intégrées. Mise en ligne comprise.", euros: 3000, kind: "ONE_OFF", category: "SITE" },
  { name: "Création de Site One-Page", description: "Page unique sur mesure : présentation, services, horaires, plan d'accès et formulaire de contact. Adaptée au mobile, mise en ligne comprise.", euros: 700, kind: "ONE_OFF", category: "SITE" },
  // Rubrique non visible sur la capture (ni « Sites » ni « Logiciels » affiché) : non classée, à confirmer.
  { name: "Intervention ponctuelle (1 h)", description: "Dépannage ou petite modification hors contrat de maintenance, jusqu'à 1 h de travail.", euros: 60, kind: "ONE_OFF", category: null },
  { name: "Logiciel de gestion", description: null, euros: 3000, kind: "ONE_OFF", category: "LOGICIEL" },
  { name: "Module complémentaire", description: "Une fonction de plus sur un outil existant : export, statistiques, rappels, nouvel écran.", euros: 600, kind: "ONE_OFF", category: "LOGICIEL" },
  { name: "Refonte (5 pages)", description: "Nouveau design et contenus repris, jusqu'à 5 pages, redirections pour conserver le référencement, site plus rapide et adapté au mobile.", euros: 1000, kind: "ONE_OFF", category: "SITE" },
  { name: "Site One Page", description: "Page unique sur mesure : présentation, services, horaires, plan d'accès et formulaire de contact. Adaptée au mobile, mise en ligne comprise.", euros: 700, kind: "ONE_OFF", category: "SITE" },
  { name: "Site association (6 pages)", description: "Présentation, actualités et agenda modifiables, adhésion ou dons via HelloAsso, espace documents. Jusqu'à 6 pages, mise en ligne comprise.", euros: 1300, kind: "ONE_OFF", category: "SITE" },
  { name: "Site commerce", description: "Carte et menus modifiables par vous, horaires, photos, lien de réservation, avis Google et plan d'accès. Mise en ligne comprise.", euros: 1200, kind: "ONE_OFF", category: "SITE" },
  { name: "Site vitrine (5 pages)", description: "Design sur mesure, jusqu'à 5 pages, formulaire de contact, référencement Google de base, fiche Google Maps reliée, mise en ligne comprise.", euros: 1300, kind: "ONE_OFF", category: "SITE" },
  { name: "Vitrine étendue (10 pages)", description: "Jusqu'à 10 pages dont une rubrique actualités administrable, version anglaise possible en option, référencement local renforcé.", euros: 1900, kind: "ONE_OFF", category: "SITE" },
];

// Onglet Options (capture 019).
const OPTIONS: Item[] = [
  { name: "Fiche Google Maps", description: "Création ou reprise de la fiche d'établissement : catégories, horaires, photos, lien vers le site.", euros: 150, kind: "ONE_OFF", category: "OPTION" },
  { name: "Formation (1 h 30)", description: "Séance pour modifier vous-même vos textes, photos, actualités ou menus, avec un mode d'emploi écrit.", euros: 90, kind: "ONE_OFF", category: "OPTION" },
  { name: "Pack référencement local", description: "Mots-clés de la zone, balisage, Google Search Console, vitesse optimisée, conseils pour obtenir des avis.", euros: 300, kind: "ONE_OFF", category: "OPTION" },
  { name: "Page supplémentaire", description: "Une page de plus sur un site, même design, contenus fournis par le client.", euros: 120, kind: "ONE_OFF", category: "OPTION" },
  { name: "Rédaction d'une page", description: "Rédaction des textes d'une page à partir d'un échange, optimisés pour Google.", euros: 90, kind: "ONE_OFF", category: "OPTION" },
];

// Abonnements annuels (capture 020).
const SUBSCRIPTIONS: Item[] = [
  { name: "Adresse e-mail pro (annuel)", description: "Une adresse e-mail à votre nom de domaine. Prix par adresse et par an.", euros: 72, kind: "YEARLY", category: null },
  { name: "Hébergement (annuel)", description: "Prise en charge de l'hébergement du site web", euros: 120, kind: "YEARLY", category: null },
  { name: "Maintenance Site (annuel)", description: "Hébergement compris, nom de domaine et HTTPS gérés, surveillance 24 h/24, sauvegardes, mises à jour de sécurité et corrections.", euros: 350, kind: "YEARLY", category: null },
  { name: "Maintenance boutique (annuel)", description: "Tout Maintenance site Plus pour une boutique : suivi des paiements et commandes, sauvegardes quotidiennes, intervention prioritaire.", euros: 900, kind: "YEARLY", category: null },
  { name: "Maintenance logiciel (annuel)", description: "Surveillance, sauvegardes, mises à jour de sécurité, corrections et aide aux utilisateurs par e-mail.", euros: 650, kind: "YEARLY", category: null },
  { name: "Maintenance logiciel Plus (annuel)", description: "Tout Maintenance logiciel, plus 2 h d'évolutions par mois, adaptation aux changements de vos autres outils et documentation à jour.", euros: 1300, kind: "YEARLY", category: null },
];

// Onglet Packs (capture 018) : prix = partie ponctuelle ; contenu dans l'ordre affiché.
const PACKS: Item[] = [
  { name: "Pack Association", description: "Site association 6 pages et formation, avec la maintenance du site à l'année.", euros: 1350, kind: "PACK", category: null, contents: ["Site association (6 pages)", "Formation (1 h 30)", "Maintenance Site (annuel)"] },
  { name: "Pack Boutique", description: "Boutique en ligne, fiche Google Maps et formation, avec la maintenance de la boutique à l'année.", euros: 3100, kind: "PACK", category: null, contents: ["Boutique en ligne (50 produits)", "Fiche Google Maps", "Formation (1 h 30)", "Maintenance boutique (annuel)"] },
  { name: "Pack Lancement", description: "Site une page et fiche Google Maps, avec l'hébergement à l'année.", euros: 800, kind: "PACK", category: null, contents: ["Site One Page", "Fiche Google Maps", "Hébergement (annuel)"] },
  { name: "Pack Outils Métier", description: "Outil de gestion sur mesure et formation, avec la maintenance du logiciel à l'année.", euros: 2900, kind: "PACK", category: null, contents: ["Logiciel de gestion", "Formation (1 h 30)", "Maintenance logiciel (annuel)"] },
  { name: "Pack Vitrine", description: "Site vitrine 5 pages et fiche Google Maps, avec la maintenance du site à l'année.", euros: 1400, kind: "PACK", category: null, contents: ["Site vitrine (5 pages)", "Fiche Google Maps", "Maintenance Site (annuel)"] },
  { name: "Pack commerce", description: "Site commerce, fiche Google Maps et référencement local, avec la maintenance du site à l'année.", euros: 1500, kind: "PACK", category: null, contents: ["Site commerce", "Fiche Google Maps", "Pack référencement local", "Maintenance Site (annuel)"] },
];

// Offre « tout compris » validée le 19/10/2026, absente du catalogue de production : option --tout-compris.
const TOUT_COMPRIS_DESCRIPTION =
  "Tout compris : création, hébergement, maintenance, sécurité, sauvegardes, petites modifications, fiche Google, formation.";
const TOUT_COMPRIS: Item[] = [
  { name: "Site vitrine tout compris (annuel)", description: TOUT_COMPRIS_DESCRIPTION, euros: 1500, kind: "YEARLY", category: null },
  { name: "Site commerce tout compris (annuel)", description: TOUT_COMPRIS_DESCRIPTION, euros: 1500, kind: "YEARLY", category: null },
  { name: "Boutique en ligne tout compris (annuel)", description: TOUT_COMPRIS_DESCRIPTION, euros: 2900, kind: "YEARLY", category: null },
  { name: "Site association tout compris (annuel)", description: TOUT_COMPRIS_DESCRIPTION, euros: 900, kind: "YEARLY", category: null },
];

/** Champs écrits pour une prestation (ni Stripe, ni état d'archivage : une prestation archivée le reste). */
function fieldsOf(item: Item) {
  return {
    name: item.name,
    description: item.description,
    unitPriceCents: Math.round(item.euros * 100),
    isSubscription: item.kind === "YEARLY",
    billingInterval: item.kind === "YEARLY" ? "YEAR" : null,
    isPack: item.kind === "PACK",
    category: item.category,
  };
}

async function refuseProduction(): Promise<string | null> {
  if (process.env.NODE_ENV === "production") return "NODE_ENV vaut production.";
  const settings = await prisma.companySettings.findFirst({ select: { stripeSecretKeyEncrypted: true } });
  const key = settings?.stripeSecretKeyEncrypted ? decryptOptional(settings.stripeSecretKeyEncrypted) : null;
  if (key && detectStripeMode(key) === "live") return "la clé Stripe des réglages est une clé live (base de production ?).";
  if (await prisma.service.count({ where: { stripeLivemode: true } })) return "des prestations sont liées à Stripe en mode live (base de production ?).";
  return null;
}

type Planned = { item: Item; action: "créer" | "mettre à jour" | "inchangé"; id: string | null };

async function plan(items: Item[]): Promise<Planned[]> {
  const out: Planned[] = [];
  for (const item of items) {
    const existing = await prisma.service.findFirst({ where: { name: item.name }, orderBy: { createdAt: "asc" } });
    if (!existing) {
      out.push({ item, action: "créer", id: null });
      continue;
    }
    const want = fieldsOf(item);
    const same = (Object.keys(want) as Array<keyof typeof want>).every((k) => existing[k] === want[k]);
    out.push({ item, action: same ? "inchangé" : "mettre à jour", id: existing.id });
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--oui" && a !== "--tout-compris");
  if (unknown.length) {
    console.error(`Usage : npm run catalogue:dev -- [--oui] [--tout-compris] (argument inconnu : ${unknown.join(" ")})`);
    process.exitCode = 2;
    return;
  }
  const refusal = await refuseProduction();
  if (refusal) {
    console.error(`Refusé : ${refusal} Ce script ne sert qu'à l'ERP de développement.`);
    process.exitCode = 1;
    return;
  }

  // Composants d'abord, packs ensuite (un pack référence des prestations déjà présentes).
  const components = [...SERVICES, ...OPTIONS, ...SUBSCRIPTIONS, ...(args.includes("--tout-compris") ? TOUT_COMPRIS : [])];
  const planned = [...(await plan(components)), ...(await plan(PACKS))];
  const count = (a: Planned["action"]) => planned.filter((p) => p.action === a).length;
  console.log(`Base : ${process.env.DATABASE_URL ?? "(DATABASE_URL absente)"}`);
  console.log(`Catalogue de développement : ${count("créer")} à créer, ${count("mettre à jour")} à mettre à jour, ${count("inchangé")} inchangées.`);
  for (const p of planned.filter((x) => x.action !== "inchangé")) {
    console.log(`  ${p.action} : ${p.item.name} (${p.item.euros.toLocaleString("fr-FR")} €${p.item.kind === "YEARLY" ? " par an" : p.item.kind === "PACK" ? ", pack" : ""})`);
  }
  console.log("Signalé : deux prestations à 700 € au contenu identique, « Création de Site One-Page » et « Site One Page » (reproduites telles quelles).");
  if (!count("créer") && !count("mettre à jour")) {
    console.log("Prestations déjà alignées : seul le contenu des packs est vérifié.");
  }

  if (!args.includes("--oui") && (count("créer") || count("mettre à jour"))) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Appliquer ces changements ? (oui/non) ")).trim().toLowerCase();
    rl.close();
    if (answer !== "oui" && answer !== "o") {
      console.log("Annulé : rien n'a été écrit.");
      return;
    }
  }

  for (const p of planned) {
    if (p.action === "créer") await prisma.service.create({ data: { ...fieldsOf(p.item), defaultBillingDay: 1 } });
    else if (p.action === "mettre à jour") await prisma.service.update({ where: { id: p.id! }, data: fieldsOf(p.item) });
  }
  // Contenu des packs : ajouté s'il manque, quantité et ordre réalignés ; un élément en trop n'est jamais retiré.
  let linked = 0;
  for (const pack of PACKS) {
    const packRow = await prisma.service.findFirstOrThrow({ where: { name: pack.name }, orderBy: { createdAt: "asc" } });
    for (const [position, name] of (pack.contents ?? []).entries()) {
      const part = await prisma.service.findFirstOrThrow({ where: { name }, orderBy: { createdAt: "asc" } });
      const item = await prisma.servicePackItem.findUnique({ where: { packId_serviceId: { packId: packRow.id, serviceId: part.id } } });
      if (!item) {
        await prisma.servicePackItem.create({ data: { packId: packRow.id, serviceId: part.id, quantity: 1, position } });
        linked++;
      } else if (item.quantity !== 1 || item.position !== position) {
        await prisma.servicePackItem.update({ where: { id: item.id }, data: { quantity: 1, position } });
        linked++;
      }
    }
  }
  console.log(`Fait : ${count("créer")} créées, ${count("mettre à jour")} mises à jour, ${linked} éléments de pack ajoutés ou réalignés. Aucun appel à Stripe.`);
}

main()
  .catch((e) => {
    console.error("Catalogue interrompu :", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
