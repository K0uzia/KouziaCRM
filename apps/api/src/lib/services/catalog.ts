import { ServiceUnit, type PrismaClient } from "@prisma/client";

/**
 * Catalogue Kouzia : prix fixes pensés pour les petites structures (associations, restaurants,
 * artisans, commerces). Montants en centimes, prix final payé par le client : en franchise de
 * TVA ils sont facturés tels quels ; en cas d'assujettissement, ils restent identiques TTC
 * (la TVA est alors prise sur la marge, sans hausse pour le client).
 * Repères marché 2026 : site vitrine freelance 500 à 3 000 €, maintenance corrective
 * 50 à 90 € HT par mois pour une petite entreprise.
 */
export type CatalogEntry = {
  name: string;
  description: string;
  priceCents: number;
  /** Abonnement mensuel (maintenance) ; sinon prestation ponctuelle au forfait. */
  monthly?: boolean;
};

export const CATALOG: CatalogEntry[] = [
  // Sites web
  {
    name: "Site une page",
    description:
      "Page unique sur mesure : présentation, services, horaires, plan d'accès et formulaire de contact. Adaptée au mobile, mise en ligne comprise.",
    priceCents: 69000,
  },
  {
    name: "Site vitrine (jusqu'à 5 pages)",
    description:
      "Design sur mesure, jusqu'à 5 pages, formulaire de contact, référencement Google de base, fiche Google Maps reliée, mise en ligne comprise.",
    priceCents: 129000,
  },
  {
    name: "Site restaurant",
    description:
      "Carte et menus modifiables par vous, horaires, photos, lien de réservation, avis Google et plan d'accès. Mise en ligne comprise.",
    priceCents: 119000,
  },
  {
    name: "Site association",
    description:
      "Présentation, actualités et agenda modifiables, adhésion ou dons via HelloAsso, espace documents. Jusqu'à 6 pages, mise en ligne comprise.",
    priceCents: 149000,
  },
  {
    name: "Site vitrine étendu (jusqu'à 10 pages)",
    description:
      "Jusqu'à 10 pages dont une rubrique actualités administrable, version anglaise possible en option, référencement local renforcé.",
    priceCents: 189000,
  },
  {
    name: "Boutique en ligne (jusqu'à 50 produits)",
    description:
      "Catalogue, panier, paiement en ligne sécurisé, gestion des commandes, mentions légales et CGV intégrées. Mise en ligne comprise.",
    priceCents: 249000,
  },
  {
    name: "Refonte de site (jusqu'à 5 pages)",
    description:
      "Nouveau design et contenus repris, redirections pour conserver le référencement, site plus rapide et adapté au mobile.",
    priceCents: 99000,
  },
  // Options
  {
    name: "Page supplémentaire",
    description: "Une page de plus sur un site, même design, contenus fournis par le client.",
    priceCents: 12000,
  },
  {
    name: "Rédaction d'une page",
    description: "Rédaction des textes d'une page à partir d'un échange, optimisés pour Google.",
    priceCents: 9000,
  },
  {
    name: "Fiche Google Maps (création ou optimisation)",
    description: "Création ou reprise de la fiche d'établissement : catégories, horaires, photos, lien vers le site.",
    priceCents: 15000,
  },
  {
    name: "Pack référencement local",
    description:
      "Mots-clés de la zone, balisage, Google Search Console, vitesse optimisée, conseils pour obtenir des avis.",
    priceCents: 29000,
  },
  {
    name: "Formation à la prise en main (1 h 30)",
    description: "Séance pour modifier vous-même vos textes, photos, actualités ou menus, avec un mode d'emploi écrit.",
    priceCents: 9000,
  },
  // Logiciels
  {
    name: "Atelier de cadrage logiciel",
    description: "Échange sur votre quotidien, liste des besoins, maquette des écrans principaux et devis détaillé.",
    priceCents: 39000,
  },
  {
    name: "Outil de gestion simple",
    description:
      "Application web sur mesure pour un besoin précis : stocks, réservations, planning ou suivi de matériel. Comptes utilisateurs, sauvegardes, formation.",
    priceCents: 299000,
  },
  {
    name: "Module complémentaire",
    description: "Une fonction de plus sur un outil existant : export, statistiques, rappels, nouvel écran.",
    priceCents: 59000,
  },
  {
    name: "Automatisation entre outils",
    description: "Relier deux outils (tableur, agenda, caisse, site) pour supprimer une saisie répétée.",
    priceCents: 49000,
  },
  {
    name: "Intervention ponctuelle",
    description: "Dépannage ou petite modification hors contrat de maintenance (jusqu'à 1 h de travail).",
    priceCents: 6000,
  },
  // Maintenance (abonnements mensuels)
  {
    name: "Maintenance site Essentiel",
    description:
      "Hébergement, nom de domaine et HTTPS gérés, surveillance 24 h/24, sauvegardes, mises à jour de sécurité et corrections.",
    priceCents: 2900,
    monthly: true,
  },
  {
    name: "Maintenance site Sérénité",
    description:
      "Tout l'Essentiel, plus 1 h de retouches par mois (textes, photos, menus), suivi de la vitesse et du référencement, mise à jour de la fiche Google.",
    priceCents: 4900,
    monthly: true,
  },
  {
    name: "Maintenance boutique en ligne",
    description:
      "Tout le Sérénité pour une boutique : suivi des paiements et commandes, sauvegardes quotidiennes, intervention prioritaire.",
    priceCents: 7900,
    monthly: true,
  },
  {
    name: "Maintenance logiciel Essentiel",
    description:
      "Surveillance, sauvegardes, mises à jour de sécurité, corrections et aide aux utilisateurs par email.",
    priceCents: 5900,
    monthly: true,
  },
  {
    name: "Maintenance logiciel Évolutive",
    description:
      "Tout l'Essentiel, plus 2 h d'évolutions par mois, adaptation aux changements de vos autres outils et documentation à jour.",
    priceCents: 11900,
    monthly: true,
  },
];

export type CatalogAction = {
  name: string;
  /** stripe : prestation liée à Stripe, jamais écrite par le catalogue (prix et archivage depuis l'ERP). */
  action: "create" | "update" | "same" | "differs" | "archive" | "stripe";
  /** Écarts constatés (prix, description, type, archivée) pour « update » et « differs ». */
  changes: string[];
};

export type CatalogOptions = {
  /** Aucune écriture : liste seulement ce qui serait fait. */
  dryRun?: boolean;
  /**
   * Remet les prestations existantes aux valeurs du catalogue et archive les anciennes au jour
   * ou à l'heure. Sans cette option, seules les prestations manquantes sont créées : un prix
   * modifié à la main dans l'ERP n'est jamais écrasé.
   */
  update?: boolean;
};

const euros = (cents: number) => (cents / 100).toFixed(2).replace(".", ",") + " €";

/**
 * Importe le catalogue (rapprochement par nom). Idempotent : relancé, il ne crée aucun doublon.
 * Les prestations ne sont jamais supprimées (elles peuvent figurer sur des documents émis).
 */
export async function applyCatalog(prisma: PrismaClient, opts: CatalogOptions = {}): Promise<CatalogAction[]> {
  const actions: CatalogAction[] = [];
  for (const entry of CATALOG) {
    const data = {
      description: entry.description,
      unitPriceCents: entry.priceCents,
      unit: ServiceUnit.FORFAIT,
      active: true,
      isSubscription: Boolean(entry.monthly),
    };
    const existing = await prisma.service.findFirst({ where: { name: entry.name } });
    // Prestation liée à Stripe : un prix écrit ici n'irait pas dans Stripe, et la synchro horaire (Stripe vers
    // l'ERP) le déferait. Elle se change dans Prestations, qui crée le nouveau prix Stripe.
    if (existing?.stripeProductId) {
      actions.push({ name: entry.name, action: "stripe", changes: ["liée à Stripe : changer dans l'ERP, écran Prestations"] });
      continue;
    }
    if (!existing) {
      if (!opts.dryRun) await prisma.service.create({ data: { name: entry.name, defaultBillingDay: 1, ...data } });
      actions.push({ name: entry.name, action: "create", changes: [] });
      continue;
    }
    const changes: string[] = [];
    if (existing.unitPriceCents !== data.unitPriceCents)
      changes.push(`prix ${euros(existing.unitPriceCents)} -> ${euros(data.unitPriceCents)}`);
    if ((existing.description ?? "") !== data.description) changes.push("description");
    if (existing.unit !== data.unit) changes.push(`unité ${existing.unit} -> FORFAIT`);
    if (existing.isSubscription !== data.isSubscription) changes.push(data.isSubscription ? "devient abonnement" : "devient ponctuelle");
    if (!existing.active) changes.push("réactivée");
    if (changes.length === 0) {
      actions.push({ name: entry.name, action: "same", changes });
    } else if (opts.update) {
      if (!opts.dryRun) await prisma.service.update({ where: { id: existing.id }, data });
      actions.push({ name: entry.name, action: "update", changes });
    } else {
      actions.push({ name: entry.name, action: "differs", changes });
    }
  }
  if (opts.update) {
    const legacy = await prisma.service.findMany({
      where: {
        active: true,
        name: { notIn: CATALOG.map((e) => e.name) },
        OR: [{ unit: { not: ServiceUnit.FORFAIT } }, { name: { in: ["Forfait projet", "Maintenance site web"] } }],
      },
      select: { id: true, name: true, stripeProductId: true },
    });
    for (const s of legacy) {
      if (s.stripeProductId) {
        actions.push({ name: s.name, action: "stripe", changes: ["liée à Stripe : archiver dans l'ERP, écran Prestations"] });
        continue;
      }
      if (!opts.dryRun) await prisma.service.update({ where: { id: s.id }, data: { active: false } });
      actions.push({ name: s.name, action: "archive", changes: ["archivée"] });
    }
  }
  return actions;
}
