import { ServiceUnit, type PrismaClient, type Service } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import { createLinkedService } from "@/lib/stripe/catalog-write.js";
import { removeService, updateLinkedService } from "@/lib/services/linked-write.js";

/**
 * Catalogue Kouzia (grille validée par Alexandre) : prix ronds, nets, pensés pour les petites structures
 * (associations, restaurants, artisans, commerces). Montants en centimes, prix final payé par le client : en
 * franchise de TVA ils sont facturés tels quels ; en cas d'assujettissement, ils restent identiques TTC.
 * Cinq rubriques : Sites, Logiciels, Options (champ category), Abonnements (annuels : une transaction Stripe par
 * an) et Packs (prix de la partie ponctuelle ; l'abonnement inclus reste au prix plein).
 */
export type CatalogCategory = "SITE" | "LOGICIEL" | "OPTION";

export type CatalogEntry = {
  name: string;
  description: string;
  priceCents: number;
  /** Rubrique d'une prestation ponctuelle. */
  category?: CatalogCategory;
  /** Abonnement annuel. */
  yearly?: boolean;
  /** Anciens noms : la prestation existante est reprise et renommée au lieu d'être recréée. */
  formerNames?: string[];
};

export type CatalogPack = {
  name: string;
  description: string;
  /** Prix de la partie ponctuelle ; la remise du pack est la différence avec le détail. */
  priceCents: number;
  /** Prestations du catalogue, par nom, dans l'ordre du devis. */
  items: string[];
};

export const CATALOG: CatalogEntry[] = [
  // Sites
  {
    name: "Site une page",
    category: "SITE",
    description:
      "Page unique sur mesure : présentation, services, horaires, plan d'accès et formulaire de contact. Adaptée au mobile, mise en ligne comprise.",
    priceCents: 70000,
  },
  {
    name: "Site vitrine (5 pages)",
    formerNames: ["Site vitrine (jusqu'à 5 pages)"],
    category: "SITE",
    description:
      "Design sur mesure, jusqu'à 5 pages, formulaire de contact, référencement Google de base, fiche Google Maps reliée, mise en ligne comprise.",
    priceCents: 130000,
  },
  {
    name: "Site restaurant",
    category: "SITE",
    description:
      "Carte et menus modifiables par vous, horaires, photos, lien de réservation, avis Google et plan d'accès. Mise en ligne comprise.",
    priceCents: 120000,
  },
  {
    name: "Site association (6 pages)",
    formerNames: ["Site association"],
    category: "SITE",
    description:
      "Présentation, actualités et agenda modifiables, adhésion ou dons via HelloAsso, espace documents. Jusqu'à 6 pages, mise en ligne comprise.",
    priceCents: 130000,
  },
  {
    name: "Vitrine étendue (10 pages)",
    formerNames: ["Site vitrine étendu (jusqu'à 10 pages)"],
    category: "SITE",
    description:
      "Jusqu'à 10 pages dont une rubrique actualités administrable, version anglaise possible en option, référencement local renforcé.",
    priceCents: 190000,
  },
  {
    name: "Boutique en ligne (50 produits)",
    formerNames: ["Boutique en ligne (jusqu'à 50 produits)"],
    category: "SITE",
    description:
      "Catalogue jusqu'à 50 produits, panier, paiement en ligne sécurisé, gestion des commandes, mentions légales et CGV intégrées. Mise en ligne comprise.",
    priceCents: 300000,
  },
  {
    name: "Refonte (5 pages)",
    formerNames: ["Refonte de site (jusqu'à 5 pages)"],
    category: "SITE",
    description:
      "Nouveau design et contenus repris, jusqu'à 5 pages, redirections pour conserver le référencement, site plus rapide et adapté au mobile.",
    priceCents: 100000,
  },
  // Logiciels
  {
    name: "Atelier de cadrage",
    formerNames: ["Atelier de cadrage logiciel"],
    category: "LOGICIEL",
    description: "Échange sur votre quotidien, liste des besoins, maquette des écrans principaux et devis détaillé.",
    priceCents: 40000,
  },
  {
    name: "Outil de gestion simple",
    category: "LOGICIEL",
    description:
      "À partir de 3 000 € : application web sur mesure pour un besoin précis (stocks, réservations, planning ou suivi de matériel). Comptes utilisateurs, sauvegardes, formation.",
    priceCents: 300000,
  },
  {
    name: "Module complémentaire",
    category: "LOGICIEL",
    description: "Une fonction de plus sur un outil existant : export, statistiques, rappels, nouvel écran.",
    priceCents: 60000,
  },
  {
    name: "Automatisation entre outils",
    category: "LOGICIEL",
    description: "Relier deux outils (tableur, agenda, caisse, site) pour supprimer une saisie répétée.",
    priceCents: 50000,
  },
  {
    name: "Intervention ponctuelle (1 h)",
    formerNames: ["Intervention ponctuelle"],
    category: "LOGICIEL",
    description: "Dépannage ou petite modification hors contrat de maintenance, jusqu'à 1 h de travail.",
    priceCents: 6000,
  },
  // Options
  {
    name: "Page supplémentaire",
    category: "OPTION",
    description: "Une page de plus sur un site, même design, contenus fournis par le client.",
    priceCents: 12000,
  },
  {
    name: "Rédaction d'une page",
    category: "OPTION",
    description: "Rédaction des textes d'une page à partir d'un échange, optimisés pour Google.",
    priceCents: 9000,
  },
  {
    name: "Fiche Google Maps",
    formerNames: ["Fiche Google Maps (création ou optimisation)"],
    category: "OPTION",
    description: "Création ou reprise de la fiche d'établissement : catégories, horaires, photos, lien vers le site.",
    priceCents: 15000,
  },
  {
    name: "Pack référencement local",
    category: "OPTION",
    description:
      "Mots-clés de la zone, balisage, Google Search Console, vitesse optimisée, conseils pour obtenir des avis.",
    priceCents: 30000,
  },
  {
    name: "Formation (1 h 30)",
    formerNames: ["Formation à la prise en main (1 h 30)"],
    category: "OPTION",
    description: "Séance pour modifier vous-même vos textes, photos, actualités ou menus, avec un mode d'emploi écrit.",
    priceCents: 9000,
  },
  // Abonnements (annuels)
  {
    name: "Hébergement",
    yearly: true,
    description: "Nom de domaine, hébergement et HTTPS gérés, sans intervention sur le site.",
    priceCents: 12000,
  },
  {
    name: "Maintenance site",
    formerNames: ["Maintenance site Essentiel"],
    yearly: true,
    description:
      "Hébergement compris : nom de domaine et HTTPS gérés, surveillance 24 h/24, sauvegardes, mises à jour de sécurité et corrections.",
    priceCents: 35000,
  },
  {
    name: "Maintenance site Plus",
    formerNames: ["Maintenance site Sérénité"],
    yearly: true,
    description:
      "Tout Maintenance site, plus 1 h de retouches par mois (textes, photos, menus), suivi de la vitesse et du référencement, mise à jour de la fiche Google.",
    priceCents: 65000,
  },
  {
    name: "Maintenance boutique",
    formerNames: ["Maintenance boutique en ligne"],
    yearly: true,
    description:
      "Tout Maintenance site Plus pour une boutique : suivi des paiements et commandes, sauvegardes quotidiennes, intervention prioritaire.",
    priceCents: 90000,
  },
  {
    name: "Maintenance logiciel",
    formerNames: ["Maintenance logiciel Essentiel"],
    yearly: true,
    description: "Surveillance, sauvegardes, mises à jour de sécurité, corrections et aide aux utilisateurs par e-mail.",
    priceCents: 65000,
  },
  {
    name: "Maintenance logiciel Plus",
    formerNames: ["Maintenance logiciel Évolutive"],
    yearly: true,
    description:
      "Tout Maintenance logiciel, plus 2 h d'évolutions par mois, adaptation aux changements de vos autres outils et documentation à jour.",
    priceCents: 130000,
  },
  {
    name: "Adresse e-mail pro",
    yearly: true,
    description: "Une adresse e-mail à votre nom de domaine. Prix par adresse et par an.",
    priceCents: 7200,
  },
];

export const CATALOG_PACKS: CatalogPack[] = [
  {
    name: "Pack Lancement",
    description: "Site une page et fiche Google Maps, avec l'hébergement à l'année.",
    priceCents: 80000,
    items: ["Site une page", "Fiche Google Maps", "Hébergement"],
  },
  {
    name: "Pack Vitrine",
    description: "Site vitrine 5 pages et fiche Google Maps, avec la maintenance du site à l'année.",
    priceCents: 140000,
    items: ["Site vitrine (5 pages)", "Fiche Google Maps", "Maintenance site"],
  },
  {
    name: "Pack Restaurant",
    description: "Site restaurant, fiche Google Maps et référencement local, avec la maintenance du site à l'année.",
    priceCents: 150000,
    items: ["Site restaurant", "Fiche Google Maps", "Pack référencement local", "Maintenance site"],
  },
  {
    name: "Pack Association",
    description: "Site association 6 pages et formation, avec la maintenance du site à l'année.",
    priceCents: 135000,
    items: ["Site association (6 pages)", "Formation (1 h 30)", "Maintenance site"],
  },
  {
    name: "Pack Boutique",
    description: "Boutique en ligne, fiche Google Maps et formation, avec la maintenance de la boutique à l'année.",
    priceCents: 310000,
    items: ["Boutique en ligne (50 produits)", "Fiche Google Maps", "Formation (1 h 30)", "Maintenance boutique"],
  },
  {
    name: "Pack Outil métier",
    description: "Atelier de cadrage, outil de gestion sur mesure et formation, avec la maintenance du logiciel à l'année.",
    priceCents: 330000,
    items: ["Atelier de cadrage", "Outil de gestion simple", "Formation (1 h 30)", "Maintenance logiciel"],
  },
  {
    name: "Pack Automatisation",
    description: "Atelier de cadrage et automatisation entre deux outils.",
    priceCents: 80000,
    items: ["Atelier de cadrage", "Automatisation entre outils"],
  },
];

export type CatalogAction = {
  name: string;
  /**
   * stripe : prestation liée à Stripe, jamais écrite par le catalogue (nom, prix et archivage depuis l'ERP).
   * blocked : pack dont une prestation manque (à créer ou renommer d'abord).
   */
  action:
    | "create"
    | "update"
    | "same"
    | "differs"
    | "archive"
    | "stripe"
    | "blocked"
    /** --stripe : écriture dans Stripe puis dans l'ERP, par le même chemin que l'écran Prestations. */
    | "stripe-update"
    | "stripe-create"
    | "stripe-archive"
    /** --stripe : Stripe a refusé ; rien n'a changé dans l'ERP pour cette prestation. */
    | "failed";
  /** Écarts constatés (prix, description, type, archivée) pour « update » et « differs ». */
  changes: string[];
};

export type CatalogOptions = {
  /** Aucune écriture : liste seulement ce qui serait fait. */
  dryRun?: boolean;
  /**
   * Remet les prestations existantes aux valeurs du catalogue (nom compris pour un ancien nom) et archive les
   * anciennes au jour ou à l'heure. Sans cette option, seules les prestations manquantes sont créées : un prix
   * modifié à la main dans l'ERP n'est jamais écrasé.
   */
  update?: boolean;
  /**
   * Applique aussi la grille aux prestations liées à Stripe, par le chemin de l'écran Prestations
   * (lib/services/linked-write.ts) : nom et description repoussés, nouveau prix (l'ancien archivé), offres
   * annuelles créées avec leur produit et leur prix, offres mensuelles remplacées archivées. Les contrats en cours
   * gardent leur montant et leur prix Stripe. Un échec n'arrête pas les autres. Avec dryRun : rien n'est appelé.
   */
  stripe?: boolean;
};

const stripeErrorText = (e: unknown) => (e instanceof Error ? e.message : "erreur Stripe");
/** Nom ERP d'une offre liée : « (annuel) » pour une offre annuelle, comme à sa création depuis l'ERP. */
const linkedName = (e: CatalogEntry) => (e.yearly ? `${e.name} (annuel)` : e.name);

/** Grille appliquée à une prestation liée à Stripe (--stripe). Renvoie les actions, échecs compris. */
async function applyLinked(prisma: PrismaClient, entry: CatalogEntry, existing: Service | null, dryRun: boolean): Promise<CatalogAction[]> {
  const actions: CatalogAction[] = [];
  const price = `${euros(entry.priceCents)}${entry.yearly ? " par an" : ""}`;
  // Offre à créer : absente, ou mensuelle alors que la grille la veut annuelle (un prix Stripe ne change pas de périodicité).
  const replaced = existing && entry.yearly && existing.billingInterval !== "YEAR" ? existing : null;
  if (!existing || replaced) {
    const what = `produit et prix Stripe${entry.yearly ? " annuel" : ""} créés : ${price}`;
    if (dryRun) {
      actions.push({ name: linkedName(entry), action: "stripe-create", changes: [what] });
    } else {
      try {
        const created = await createLinkedService({
          name: entry.name,
          description: entry.description,
          unitPriceCents: entry.priceCents,
          isSubscription: Boolean(entry.yearly),
          billingInterval: entry.yearly ? "YEAR" : null,
          defaultBillingDay: 1,
          requestId: `catalog-${entry.name}-${entry.priceCents}`,
        });
        if (entry.category) await prisma.service.update({ where: { id: created.id }, data: { category: entry.category } });
        actions.push({ name: created.name, action: "stripe-create", changes: [what] });
      } catch (e) {
        actions.push({ name: linkedName(entry), action: "failed", changes: [stripeErrorText(e)] });
        return actions;
      }
    }
  } else {
    const target = linkedName(entry);
    const changes: string[] = [];
    if (existing.name !== target) changes.push(`renommée « ${existing.name} » -> « ${target} » (Stripe compris)`);
    if (existing.unitPriceCents !== entry.priceCents) changes.push(`nouveau prix Stripe ${euros(existing.unitPriceCents)} -> ${price}, l'ancien archivé`);
    if ((existing.description ?? "") !== entry.description) changes.push("description (Stripe compris)");
    if (!existing.isSubscription && (existing.category ?? null) !== (entry.category ?? null)) changes.push("rubrique");
    if (changes.length === 0) {
      actions.push({ name: existing.name, action: "same", changes });
    } else if (dryRun) {
      actions.push({ name: existing.name, action: "stripe-update", changes });
    } else {
      try {
        await updateLinkedService(
          existing,
          {
            name: target,
            description: entry.description,
            unitPriceCents: entry.priceCents,
            defaultBillingDay: existing.defaultBillingDay,
            category: entry.category ?? null,
          },
          `catalog-${existing.id}-${entry.priceCents}`,
        );
        actions.push({ name: target, action: "stripe-update", changes });
      } catch (e) {
        actions.push({ name: existing.name, action: "failed", changes: [stripeErrorText(e)] });
      }
    }
  }
  // Offres mensuelles remplacées par l'offre annuelle (ancien nom, liées, encore actives) : archivées comme depuis l'écran.
  if (entry.yearly) {
    const monthly = await prisma.service.findMany({
      where: {
        name: { in: [entry.name, ...(entry.formerNames ?? [])] },
        stripeProductId: { not: null },
        active: true,
        NOT: { billingInterval: "YEAR" },
      },
    });
    for (const old of monthly) {
      const what = "offre mensuelle archivée (Stripe compris) ; les contrats en cours gardent leur montant et leur prix";
      if (dryRun) {
        actions.push({ name: old.name, action: "stripe-archive", changes: [what] });
        continue;
      }
      try {
        await removeService(old.id);
        actions.push({ name: old.name, action: "stripe-archive", changes: [what] });
      } catch (e) {
        actions.push({ name: old.name, action: "failed", changes: [stripeErrorText(e)] });
      }
    }
  }
  return actions;
}

const euros = (cents: number) => (cents / 100).toFixed(2).replace(".", ",") + " €";

/** Noms sous lesquels une prestation peut déjà exister (« (annuel) » : suffixe d'une offre créée par Stripe). */
const knownNames = (e: { name: string; formerNames?: string[] }) =>
  [e.name, ...(e.formerNames ?? [])].flatMap((n) => [n, `${n} (annuel)`]);

async function findByNames(prisma: PrismaClient, names: string[]): Promise<Service | null> {
  // Le nom actuel d'abord, puis les anciens : une prestation déjà renommée n'est jamais dédoublée.
  for (const name of names) {
    const found = await prisma.service.findFirst({ where: { name } });
    if (found) return found;
  }
  return null;
}

/**
 * Importe le catalogue (rapprochement par nom, ancien nom compris). Idempotent : relancé, il ne crée aucun doublon.
 * Les prestations ne sont jamais supprimées (elles peuvent figurer sur des documents émis). Une prestation liée à
 * Stripe n'est jamais modifiée : seule sa rubrique est posée si elle manque (classement local, sans effet sur Stripe).
 */
export async function applyCatalog(prisma: PrismaClient, opts: CatalogOptions = {}): Promise<CatalogAction[]> {
  const actions: CatalogAction[] = [];
  if (opts.stripe && !(await getCompanySettings()).moduleStripeEnabled) {
    throw new Error("--stripe : le module Stripe est inactif dans les réglages de l'ERP.");
  }
  for (const entry of CATALOG) {
    const data = {
      name: entry.name,
      description: entry.description,
      unitPriceCents: entry.priceCents,
      unit: ServiceUnit.FORFAIT,
      active: true,
      isSubscription: Boolean(entry.yearly),
      billingInterval: entry.yearly ? "YEAR" : null,
      category: entry.category ?? null,
    };
    const existing = await findByNames(prisma, knownNames(entry));
    // Prestation liée à Stripe : un prix écrit ici n'irait pas dans Stripe, et la synchro horaire (Stripe vers
    // l'ERP) le déferait. Elle se change dans Prestations, qui crée le nouveau prix Stripe.
    // --stripe : prestations liées et prestations à créer passent par Stripe (module Stripe actif).
    if (opts.stripe && (!existing || existing.stripeProductId)) {
      actions.push(...(await applyLinked(prisma, entry, existing, Boolean(opts.dryRun))));
      continue;
    }
    if (existing?.stripeProductId) {
      const changes = [`liée à Stripe : changer dans l'ERP, écran Prestations (cible : « ${entry.name} », ${euros(entry.priceCents)}${entry.yearly ? " par an" : ""})`];
      if (data.category && !existing.category) {
        if (!opts.dryRun) await prisma.service.update({ where: { id: existing.id }, data: { category: data.category } });
        changes.push("rubrique posée");
      }
      actions.push({ name: existing.name, action: "stripe", changes });
      continue;
    }
    if (!existing) {
      if (!opts.dryRun) await prisma.service.create({ data: { defaultBillingDay: 1, ...data } });
      actions.push({ name: entry.name, action: "create", changes: [] });
      continue;
    }
    const changes: string[] = [];
    if (existing.name !== data.name) changes.push(`renommée « ${existing.name} » -> « ${data.name} »`);
    if (existing.unitPriceCents !== data.unitPriceCents)
      changes.push(`prix ${euros(existing.unitPriceCents)} -> ${euros(data.unitPriceCents)}`);
    if ((existing.description ?? "") !== data.description) changes.push("description");
    if (existing.unit !== data.unit) changes.push(`unité ${existing.unit} -> FORFAIT`);
    if (existing.isSubscription !== data.isSubscription) changes.push(data.isSubscription ? "devient abonnement" : "devient ponctuelle");
    if (data.isSubscription && existing.billingInterval !== data.billingInterval) changes.push("devient annuel");
    if ((existing.category ?? null) !== data.category) changes.push("rubrique");
    if (!existing.active) changes.push("réactivée");
    if (changes.length === 0) {
      actions.push({ name: entry.name, action: "same", changes });
    } else if (opts.update) {
      if (!opts.dryRun) await prisma.service.update({ where: { id: existing.id }, data });
      actions.push({ name: entry.name, action: "update", changes });
    } else {
      actions.push({ name: existing.name, action: "differs", changes });
    }
  }

  // Packs : après les prestations, qu'ils référencent par nom (actuel, ou celui d'une offre Stripe « (annuel) »).
  for (const pack of CATALOG_PACKS) {
    const components = await Promise.all(pack.items.map((n) => findByNames(prisma, [n, `${n} (annuel)`])));
    const missing = pack.items.filter((_, i) => !components[i]);
    const existing = await prisma.service.findFirst({ where: { name: pack.name, isPack: true }, include: { packItems: true } });
    if (missing.length) {
      // En simulation, une prestation « à créer » n'existe pas encore : le pack est alors annoncé, pas bloqué.
      const willExist =
        opts.dryRun &&
        missing.every((n) =>
          actions.some(
            (a) =>
              // Créée, ou renommée vers ce nom (l'action porte encore l'ancien nom).
              ((a.name === n || a.name === `${n} (annuel)`) && (a.action === "create" || a.action === "stripe-create")) ||
              (a.action === "stripe-update" && a.changes.some((c) => c.includes(`-> « ${n} »`) || c.includes(`-> « ${n} (annuel) »`))),
          ),
        );
      if (!willExist) {
        actions.push({ name: pack.name, action: "blocked", changes: missing.map((n) => `prestation « ${n} » introuvable : la créer ou la renommer d'abord`) });
        continue;
      }
    }
    const items = components.map((c, position) => ({ serviceId: c?.id ?? "", quantity: 1, position }));
    const data = { name: pack.name, description: pack.description, unitPriceCents: pack.priceCents, unit: ServiceUnit.FORFAIT, active: true, isPack: true };
    if (!existing) {
      if (!opts.dryRun) await prisma.service.create({ data: { ...data, packItems: { create: items } } });
      actions.push({ name: pack.name, action: "create", changes: [] });
      continue;
    }
    const changes: string[] = [];
    if (existing.unitPriceCents !== pack.priceCents) changes.push(`prix ${euros(existing.unitPriceCents)} -> ${euros(pack.priceCents)}`);
    if ((existing.description ?? "") !== pack.description) changes.push("description");
    const same = existing.packItems.length === items.length && existing.packItems.every((i) => items.some((x) => x.serviceId === i.serviceId && x.position === i.position));
    if (!same) changes.push("contenu");
    if (!existing.active) changes.push("réactivé");
    if (changes.length === 0) {
      actions.push({ name: pack.name, action: "same", changes });
    } else if (opts.update) {
      if (!opts.dryRun) {
        await prisma.$transaction([
          prisma.servicePackItem.deleteMany({ where: { packId: existing.id } }),
          prisma.service.update({ where: { id: existing.id }, data: { ...data, packItems: { create: items } } }),
        ]);
      }
      actions.push({ name: pack.name, action: "update", changes });
    } else {
      actions.push({ name: pack.name, action: "differs", changes });
    }
  }

  if (opts.update) {
    const legacy = await prisma.service.findMany({
      where: {
        active: true,
        name: { notIn: [...CATALOG.flatMap(knownNames), ...CATALOG_PACKS.map((p) => p.name)] },
        OR: [{ unit: { not: ServiceUnit.FORFAIT } }, { name: { in: ["Forfait projet", "Maintenance site web"] } }],
      },
      select: { id: true, name: true, stripeProductId: true },
    });
    for (const s of legacy) {
      if (s.stripeProductId) {
        if (!opts.stripe) {
          actions.push({ name: s.name, action: "stripe", changes: ["liée à Stripe : archiver dans l'ERP, écran Prestations"] });
        } else if (opts.dryRun) {
          actions.push({ name: s.name, action: "stripe-archive", changes: ["archivée (Stripe compris)"] });
        } else {
          try {
            await removeService(s.id);
            actions.push({ name: s.name, action: "stripe-archive", changes: ["archivée (Stripe compris)"] });
          } catch (e) {
            actions.push({ name: s.name, action: "failed", changes: [stripeErrorText(e)] });
          }
        }
        continue;
      }
      if (!opts.dryRun) await prisma.service.update({ where: { id: s.id }, data: { active: false } });
      actions.push({ name: s.name, action: "archive", changes: ["archivée"] });
    }
  }
  return actions;
}
