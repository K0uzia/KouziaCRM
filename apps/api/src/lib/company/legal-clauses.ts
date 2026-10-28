import { ClientType, LegalClauseAudience, LegalClauseKind, type LegalClause } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";

/** Clause telle qu'imprimée : ce que fige l'instantané d'un devis émis (Invoice.legalClausesSnapshot). */
export type ClauseText = Pick<LegalClause, "kind" | "title" | "body" | "audience" | "position">;

const clauseSnapshotSchema = z.array(
  z.object({
    kind: z.nativeEnum(LegalClauseKind),
    title: z.string(),
    body: z.string(),
    audience: z.nativeEnum(LegalClauseAudience),
    position: z.number().int(),
  }),
);

/** Variable de la mention de TVA (réglage vatMention, seule source de la mention). */
export const VAT_MENTION_VARIABLE = "{{mention_tva}}";

/**
 * Instantané figé à l'émission d'un devis : clauses actives pour le type du client, texte brut, sauf la mention de TVA,
 * figée avec la valeur du réglage à l'émission (un devis déjà envoyé garde sa mention si le réglage change).
 */
export function snapshotOfClauses(clauses: ReadonlyArray<ClauseText>, clientType: string | null | undefined, vatMention: string): ClauseText[] {
  return clausesForClient([...clauses], clientType).map(({ kind, title, body, audience, position }) => ({
    kind,
    title,
    body: body.replaceAll(VAT_MENTION_VARIABLE, vatMention),
    audience,
    position,
  }));
}

/**
 * Clauses d'un document (décision du 23/10/2026) : celles figées à l'émission du devis, sinon les clauses actives
 * (brouillon, facture, avoir, devis émis avant la migration 20261205090000). Instantané illisible : clauses actives.
 */
export function documentClauses<T extends ClauseText>(doc: { legalClausesSnapshot?: unknown }, active: T[]): ClauseText[] {
  if (doc.legalClausesSnapshot == null) return active;
  const parsed = clauseSnapshotSchema.safeParse(doc.legalClausesSnapshot);
  return parsed.success ? parsed.data : active;
}

/**
 * Clause d'engagement (CGV du 28/10/2026, article « Abonnements avec engagement ») : engagement depuis la signature, ou
 * depuis la livraison pour une option retenue sur un devis payé une fois ; paiement au rythme du devis ; départ anticipé ;
 * reconduction annuelle avec un mois de préavis ; information L215-1.
 */
const COMMITMENT_CLAUSE =
  "Abonnement conclu pour la durée d'engagement indiquée ci-dessus (12, 24 ou 36 mois), à compter de la signature du devis ; pour une option retenue à la signature d'un devis payé une fois, l'engagement court à compter de la livraison, date à laquelle l'abonnement démarre. Le prix est fixe pendant toute la durée de l'engagement. Il est payable d'avance {{periodicite}}, par échéances d'un {{periode}}, comme indiqué sur le devis : ce fractionnement est une facilité de paiement, il ne permet pas de mettre fin à l'abonnement en cours d'engagement. Le client peut demander à tout moment la fin de son abonnement, depuis l'espace client ou par e-mail à {{email}} ; pendant l'engagement, les échéances restant à courir jusqu'à la fin de l'engagement restent dues. À la fin de l'engagement, l'abonnement est reconduit tacitement par périodes d'un an, au même rythme de paiement. Le client peut en demander la non-reconduction, sans frais ni justification, au plus tard un mois avant la fin de l'engagement ou de l'année reconduite en cours, depuis l'espace client ou par e-mail à {{email}} : l'abonnement prend alors fin à cette date. {{nom_commercial}} l'informe de cette possibilité par e-mail, au plus tôt trois mois et au plus tard un mois avant cette date limite (art. L215-1 du Code de la consommation). Dans tous les cas, le client conserve ses contenus et son nom de domaine.";

/** Clause d'une périodicité, pour une ligne ancienne sans durée d'engagement : un an, puis reconduction annuelle. */
const PERIOD_CLAUSE = (rhythm: string) =>
  `Abonnement conclu pour un an à compter de la signature du devis (pour une option retenue à la signature d'un devis payé une fois : à compter de la livraison), payable d'avance ${rhythm}, comme indiqué sur le devis. Ce rythme de paiement est une facilité : il ne permet pas de mettre fin à l'abonnement en cours d'année, les échéances de l'année en cours restent dues. L'abonnement est ensuite reconduit tacitement par périodes d'un an, au même rythme de paiement. Le client peut en demander la non-reconduction, sans frais ni justification, au plus tard un mois avant la fin de l'année en cours, depuis l'espace client ou par e-mail à {{email}} : l'abonnement prend alors fin à cette date. {{nom_commercial}} l'informe de cette possibilité par e-mail, au plus tôt trois mois et au plus tard un mois avant cette date limite (art. L215-1 du Code de la consommation). Dans tous les cas, le client conserve ses contenus et son nom de domaine.`;

/**
 * Anciens textes par défaut (avant le 28/10/2026) et textes relevés en production le 28/10/2026, remplacés par
 * upgradeDefaultClauseTexts dans une base existante seulement si la clause a encore ce texte (espaces normalisés) :
 * une clause modifiée autrement n'est jamais touchée.
 */
export const REPLACED_DEFAULT_BODIES: ReadonlyArray<{ kind: LegalClauseKind; oldBody: string; newBody: string }> = [
  { kind: LegalClauseKind.SUBSCRIPTION_MONTHLY, oldBody: "Sans durée minimale. Résiliable à tout moment, sans frais ni justification : la résiliation prend effet à la fin de la période mensuelle en cours, déjà facturée, sans remboursement au prorata. Résiliation en ligne depuis l'espace client (« Gérer mon abonnement » pour un prélèvement, « Résilier mon abonnement » pour un règlement par virement) ou par e-mail à {{email}}.", newBody: PERIOD_CLAUSE("chaque mois") },
  { kind: LegalClauseKind.SUBSCRIPTION_ANNUAL, oldBody: "Durée d'un an à compter de sa date de départ, payable d'avance, reconduite tacitement pour un an au prix en vigueur. Le client peut refuser la reconduction, sans frais ni justification, jusqu'à la veille de la date de renouvellement ; {{nom_commercial}} l'en informe par e-mail au plus tôt trois mois et au plus tard un mois avant cette date limite (art. L215-1 du Code de la consommation). Non résiliable en cours d'année, sauf manquement de {{nom_commercial}} ou force majeure. Refus de reconduction ou résiliation en ligne depuis l'espace client, ou par e-mail à {{email}}.", newBody: PERIOD_CLAUSE("chaque année à la date anniversaire") },
  { kind: LegalClauseKind.SUBSCRIPTION_QUARTERLY, oldBody: "[BROUILLON À RELIRE PAR ALEXANDRE] Sans durée minimale, payable d'avance chaque trimestre. Résiliable à tout moment, sans frais ni justification : la résiliation prend effet à la fin du trimestre en cours, déjà facturé, sans remboursement au prorata. Résiliation en ligne depuis l'espace client (« Gérer mon abonnement » pour un prélèvement, « Résilier mon abonnement » pour un règlement par virement) ou par e-mail à {{email}}.", newBody: PERIOD_CLAUSE("chaque trimestre") },
  // Même texte sans la mention de tête (production, 28/10/2026).
  { kind: LegalClauseKind.SUBSCRIPTION_QUARTERLY, oldBody: "Sans durée minimale, payable d'avance chaque trimestre. Résiliable à tout moment, sans frais ni justification : la résiliation prend effet à la fin du trimestre en cours, déjà facturé, sans remboursement au prorata. Résiliation en ligne depuis l'espace client (« Gérer mon abonnement » pour un prélèvement, « Résilier mon abonnement » pour un règlement par virement) ou par e-mail à {{email}}.", newBody: PERIOD_CLAUSE("chaque trimestre") },
  { kind: LegalClauseKind.SUBSCRIPTION_COMMITMENT, oldBody: "[BROUILLON À RELIRE PAR ALEXANDRE ET UN JURISTE OU LA CCI] Abonnement conclu pour la durée d'engagement indiquée ci-dessus, à compter de la signature du devis, payable d'avance chaque année à la date anniversaire. Pendant l'engagement, le client peut demander la résiliation depuis l'espace client ou par e-mail à {{email}} ; en cas de départ anticipé, les annuités restant à courir jusqu'à la fin de l'engagement restent dues. [À FAIRE VALIDER : une indemnité jugée excessive peut être réduite par le juge (art. 1231-5 du Code civil) ; le droit de rétractation de 14 jours prévaut pour les petits professionnels signés hors établissement (art. L221-3 du Code de la consommation).] À l'issue de l'engagement, l'abonnement se poursuit d'année en année au prix en vigueur : le client peut refuser chaque reconduction, sans frais ni justification, jusqu'à la veille de la date de renouvellement, et {{nom_commercial}} l'en informe par e-mail avant cette date. Après l'engagement, la résiliation est libre et prend effet à l'échéance annuelle. Dans tous les cas, le client conserve ses contenus et son nom de domaine.", newBody: COMMITMENT_CLAUSE },
  { kind: LegalClauseKind.SUBSCRIPTION_COMMITMENT, oldBody: "[BROUILLON À RELIRE PAR ALEXANDRE ET UN JURISTE OU LA CCI] Abonnement conclu pour la durée d'engagement indiquée ci-dessus, de 12 mois au minimum, à compter de la signature du devis. Le prix est celui de l'engagement ; il est payable d'avance {{periodicite}}, par échéances d'un {{periode}}. Ce fractionnement est une facilité de paiement : il ne permet pas de résilier en cours d'engagement, et les échéances restent dues jusqu'à la fin de l'engagement. [À FAIRE VALIDER : une indemnité jugée excessive peut être réduite par le juge (art. 1231-5 du Code civil) ; le droit de rétractation de 14 jours prévaut pour les particuliers et pour les petits professionnels signés hors établissement (art. L221-18 et L221-3 du Code de la consommation).] À la fin de l'engagement, l'abonnement est reconduit tacitement par périodes d'un an, au prix en vigueur et au même rythme de paiement. Le client peut en demander la non-reconduction, sans frais ni justification, au plus tard un mois avant la fin de l'engagement ou de l'année reconduite en cours, depuis l'espace client ou par e-mail à {{email}} : l'abonnement prend alors fin à cette date. {{nom_commercial}} lui rappelle cette date limite par e-mail avant qu'elle n'expire (art. L215-1 du Code de la consommation). Dans tous les cas, le client conserve ses contenus et son nom de domaine.", newBody: COMMITMENT_CLAUSE },
];

export const DEFAULT_LEGAL_CLAUSES: Array<{
  kind: LegalClauseKind;
  title: string;
  body: string;
  required: boolean;
  position: number;
  audience?: LegalClauseAudience;
  /** Créée sur une base neuve (ou par migration) seulement : supprimée par l'admin, elle ne revient pas. */
  seedOnly?: boolean;
  /** false : proposition créée inactive, à activer par l'admin. */
  active?: boolean;
}> = [
  {
    kind: LegalClauseKind.VAT,
    title: "Franchise en base de TVA",
    body: VAT_MENTION_VARIABLE,
    required: true,
    position: 0,
  },
  {
    kind: LegalClauseKind.PAYMENT,
    title: "Conditions de paiement",
    body: "Paiement à réception de facture",
    required: true,
    position: 1,
  },
  {
    kind: LegalClauseKind.PENALTY,
    title: "Pénalités de retard",
    body: "En cas de retard de paiement, une pénalité égale à 3 fois le taux d'intérêt légal sera due, ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement (art. L441-10 et D441-5 du code de commerce).",
    required: true,
    position: 2,
    // Code de commerce : relations entre professionnels seulement.
    audience: LegalClauseAudience.B2B,
  },
  {
    kind: LegalClauseKind.PENALTY,
    title: "Retard de paiement (particuliers)",
    body: "En cas de retard de paiement, des intérêts au taux légal pourront être appliqués après mise en demeure (article 1231-6 du Code civil).",
    required: false,
    position: 2,
    // Non-professionnels : particuliers et associations (titre gardé : il identifie la clause par défaut en base).
    audience: LegalClauseAudience.NON_PROFESSIONAL,
    seedOnly: true,
  },
  {
    kind: LegalClauseKind.SUSPENSION,
    title: "Suspension des prestations",
    body: "En cas de non-paiement d'une échéance, les prestations peuvent être suspendues jusqu'à régularisation.",
    required: true,
    position: 3,
  },
  {
    kind: LegalClauseKind.CUSTOM,
    title: "Facturation électronique (calendrier EI / micro)",
    body: "En tant qu'entreprise individuelle / micro-entreprise, le Prestataire est tenu de pouvoir recevoir des factures électroniques via une plateforme agréée depuis le 1er septembre 2026. L'obligation d'émettre ses propres factures de vente au format électronique via une plateforme agréée s'applique à compter du 1er septembre 2027 (réforme de la facturation électronique, art. 289 bis et suivants du CGI). Jusqu'à cette date, les factures peuvent être émises et transmises dans les formats habituellement utilisés (notamment PDF), sans préjudice des mentions légales obligatoires.",
    required: false,
    position: 4,
  },
  // Imprimées dans l'encadré d'abonnement du devis, alignées sur les CGV du 28/10/2026 (article « Abonnements avec
  // engagement »). Tout abonnement a un engagement : la clause d'engagement s'imprime à la place de celle de sa
  // périodicité ; les trois clauses de périodicité ne servent plus qu'aux lignes anciennes, sans durée d'engagement.
  // {{nom_commercial}}, {{email}}, {{adresse}}, {{mention_tva}}, {{periode}}, {{periodicite}} : remplacés au rendu du PDF.
  {
    kind: LegalClauseKind.SUBSCRIPTION_MONTHLY,
    title: "Abonnement mensuel",
    body: PERIOD_CLAUSE("chaque mois"),
    required: true,
    position: 5,
  },
  {
    kind: LegalClauseKind.SUBSCRIPTION_ANNUAL,
    title: "Abonnement annuel",
    body: PERIOD_CLAUSE("chaque année à la date anniversaire"),
    required: true,
    position: 6,
  },
  {
    kind: LegalClauseKind.SUBSCRIPTION_QUARTERLY,
    title: "Abonnement trimestriel",
    body: PERIOD_CLAUSE("chaque trimestre"),
    required: true,
    position: 6,
  },
  // Clause unique des abonnements engagés, tout rythme de paiement (décision d'Alexandre du 28/10/2026 : elle remplace
  // l'ancien texte annuel et la proposition inactive, upgradeDefaultClauseTexts).
  {
    kind: LegalClauseKind.SUBSCRIPTION_COMMITMENT,
    title: "Abonnement avec engagement",
    body: COMMITMENT_CLAUSE,
    required: true,
    position: 6,
  },
  // Devis contenant un abonnement : imprimée sous les abonnements et le total du projet (PDF, fiche, e-mail d'envoi).
  {
    kind: LegalClauseKind.SUBSCRIPTION_BILLING_DATE,
    title: "Date de prélèvement de l'abonnement",
    body: "Si la date de prélèvement de l'abonnement ne vous convient pas, refusez ce devis en indiquant la date souhaitée : je vous en envoie un nouveau.",
    required: true,
    position: 6,
  },
  // Information précontractuelle obligatoire envers un consommateur (art. L221-5) : sans elle, le
  // délai de rétractation est prolongé de 12 mois (art. L221-20). Devis des clients particuliers.
  {
    kind: LegalClauseKind.WITHDRAWAL,
    title: "Droit de rétractation (particuliers)",
    body: [
      "Vous disposez d'un délai de 14 jours à compter de la signature du devis pour vous rétracter, sans motif et sans frais (art. L221-18 du Code de la consommation). S'il expire un samedi, un dimanche ou un jour férié, il est prolongé jusqu'au premier jour ouvrable suivant. Pour l'exercer, informez {{nom_commercial}} de votre décision avant la fin du délai par une déclaration sans ambiguïté envoyée à {{email}}, par exemple au moyen du formulaire ci-dessous. Toutes les sommes versées vous sont remboursées au plus tard 14 jours après réception de votre rétractation, par le même moyen de paiement.",
      "Sans demande de votre part, les travaux et la première période d'un abonnement commencent au plus tôt à l'expiration du délai. Si vous demandez, à la signature, que la prestation commence avant, vous paierez en cas de rétractation un montant proportionnel à ce qui aura été fourni (art. L221-25) ; si la prestation est entièrement exécutée avant la fin du délai, vous perdez votre droit de rétractation (art. L221-28).",
      "Formulaire de rétractation (à compléter et renvoyer uniquement si vous souhaitez vous rétracter du contrat) : à l'attention de {{raison_sociale}}, {{adresse}}, {{email}}. Je/Nous (*) vous notifie/notifions (*) par la présente ma/notre (*) rétractation du contrat portant sur la prestation de services ci-dessous. Devis n° : ........ Signé le : ........ Nom du (des) consommateur(s) : ........ Adresse du (des) consommateur(s) : ........ Signature du (des) consommateur(s) (uniquement en cas de notification du présent formulaire sur papier) : ........ Date : ........ (*) Rayez la mention inutile.",
    ].join("\n"),
    required: true,
    position: 7,
    audience: LegalClauseAudience.B2C,
  },
  // Cession du site lors du rachat (R2, décision Q6) : emplacement à rédiger par Alexandre, créé inactif, sans texte
  // juridique écrit ici. Une fois activé, il ne s'imprime que sur un devis de rachat (build-payload).
  {
    kind: LegalClauseKind.BUYOUT_TRANSFER,
    title: "Cession du site (rachat)",
    body: "[À RÉDIGER PAR ALEXANDRE : ce qui est cédé au client lors du rachat (site, contenus, nom de domaine, accès) et les modalités du transfert.]",
    required: false,
    position: 8,
    active: false,
  },
  // Devis en paiement unique (décisions du 28/10/2026) : liste « Non compris » imprimée sous la formule, ce qui la
  // distingue de l'abonnement annuel. Une ligne « - » par point ; figée à l'émission du devis (scopeSnapshot).
  {
    kind: LegalClauseKind.ONE_OFF_SCOPE,
    title: "Paiement unique : ce qui n'est pas compris",
    body: [
      "- La maintenance, les mises à jour et les sauvegardes : disponibles en option, par abonnement annuel.",
      "- Sans l'option maintenance, l'hébergement et le renouvellement du nom de domaine : vous hébergez le site vous-même.",
      "- Les retouches et évolutions après la livraison : sur devis séparé.",
      "- À savoir : après paiement complet, le site et les éléments créés pour vous vous appartiennent (CGV, article « Propriété intellectuelle et livrables »).",
    ].join("\n"),
    required: false,
    position: 9,
  },
  {
    kind: LegalClauseKind.ONE_OFF_SCOPE_SOFTWARE,
    title: "Paiement unique : ce qui n'est pas compris (logiciel)",
    body: [
      "- La maintenance, les mises à jour et les sauvegardes : disponibles en option, par abonnement annuel.",
      "- Sans l'option maintenance, l'hébergement : vous installez et hébergez le logiciel vous-même.",
      "- Les retouches et évolutions après la livraison : sur devis séparé.",
      "- À savoir : après paiement complet, le logiciel et les éléments créés pour vous vous appartiennent, sauf licence prévue au devis (CGV, article « Propriété intellectuelle et livrables »).",
    ].join("\n"),
    required: false,
    position: 9,
  },
];

/** Clauses imprimées dans leur propre bloc du devis, jamais dans la liste des mentions. */
export const DEDICATED_CLAUSE_KINDS: ReadonlySet<LegalClauseKind> = new Set([
  LegalClauseKind.SUBSCRIPTION_MONTHLY,
  LegalClauseKind.SUBSCRIPTION_ANNUAL,
  LegalClauseKind.SUBSCRIPTION_QUARTERLY,
  LegalClauseKind.WITHDRAWAL,
  LegalClauseKind.SUBSCRIPTION_BILLING_DATE,
  LegalClauseKind.SUBSCRIPTION_COMMITMENT,
  LegalClauseKind.ONE_OFF_SCOPE,
  LegalClauseKind.ONE_OFF_SCOPE_SOFTWARE,
]);

/** E-mail de contact absent des réglages : manque visible sur le document, jamais un blanc. */
export const MISSING_CONTACT_EMAIL = "[e-mail de contact à renseigner dans Réglages]";

/** {{periode}} et {{periodicite}} des clauses d'abonnement, selon la périodicité de la ligne. */
const PERIOD_VARIABLES = {
  MONTH: { periode: "mois", periodicite: "chaque mois" },
  QUARTER: { periode: "trimestre", periodicite: "chaque trimestre" },
  YEAR: { periode: "an", periodicite: "chaque année à la date anniversaire" },
} as const;

/** Rythme au choix : « au rythme choisi à la signature », « par échéances d'un an ou d'un mois, selon ce rythme ». */
function choicePeriodVariables(list: ReadonlyArray<"MONTH" | "QUARTER" | "YEAR">) {
  const words = (["YEAR", "QUARTER", "MONTH"] as const).filter((iv) => list.includes(iv)).map((iv) => PERIOD_VARIABLES[iv].periode);
  const joined = words.length > 1 ? `${words.slice(0, -1).join(", ")} ou ${words[words.length - 1]}` : (words[0] ?? "");
  return { periode: `${joined}, selon ce rythme`, periodicite: "au rythme choisi à la signature" };
}

/**
 * Variables des clauses, remplacées par les réglages de l'entreprise au rendu. E-mail : celui de
 * l'entreprise, à défaut l'adresse d'envoi des e-mails (celle à laquelle le client répond).
 * Clause d'abonnement : `interval` remplit {{periode}} et {{periodicite}} (laissées telles quelles sans abonnement).
 */
export function fillClauseVariables(
  body: string,
  company: {
    legalName: string;
    tradeName: string | null;
    email: string | null;
    smtpFrom?: string | null;
    addressLine1: string;
    addressLine2: string | null;
    postalCode: string;
    city: string;
    vatMention?: string | null;
  },
  /** Plusieurs rythmes : rythme au choix du client, pas encore retenu (devis non signé). */
  interval?: "MONTH" | "QUARTER" | "YEAR" | ReadonlyArray<"MONTH" | "QUARTER" | "YEAR">,
): string {
  const address = [company.addressLine1, company.addressLine2, `${company.postalCode} ${company.city}`].filter(Boolean).join(", ");
  // Adresse d'envoi au format « Nom <adresse> » : seule l'adresse est imprimée.
  const smtpAddress = company.smtpFrom?.match(/<([^>]+)>/)?.[1] ?? company.smtpFrom;
  const email = company.email?.trim() || smtpAddress?.trim() || MISSING_CONTACT_EMAIL;
  const period = typeof interval === "string" ? PERIOD_VARIABLES[interval] : interval?.length ? choicePeriodVariables(interval) : null;
  const filled = period ? body.replaceAll("{{periode}}", period.periode).replaceAll("{{periodicite}}", period.periodicite) : body;
  return filled
    .replaceAll("{{nom_commercial}}", company.tradeName ?? company.legalName)
    .replaceAll("{{raison_sociale}}", company.legalName)
    .replaceAll("{{adresse}}", address)
    .replaceAll("{{email}}", email)
    .replaceAll(VAT_MENTION_VARIABLE, company.vatMention?.trim() ?? "");
}

export async function ensureDefaultLegalClauses() {
  const count = await prisma.legalClause.count();
  if (count === 0) {
    await prisma.legalClause.createMany({
      data: DEFAULT_LEGAL_CLAUSES.map(({ seedOnly: _seedOnly, active, ...c }) => ({
        ...c,
        active: active ?? true,
      })),
    });
    return;
  }

  // Bases déjà seedées : ajouter les clauses manquantes par titre (sans doublon). Une clause supprimée par l'admin
  // reste en base (deletedAt) et compte comme présente : elle ne revient jamais (bug du 26/10/2026).
  for (const { seedOnly, active, ...clause } of DEFAULT_LEGAL_CLAUSES) {
    if (seedOnly) continue;
    const existing = await prisma.legalClause.findFirst({
      where: { title: clause.title },
    });
    if (!existing) {
      await prisma.legalClause.create({
        data: { ...clause, active: active ?? true },
      });
    }
  }
  await upgradeDefaultClauseTexts();
}

/**
 * Mise à jour des textes par défaut d'abonnement (accord d'Alexandre du 28/10/2026), idempotente : seule une clause
 * dont le texte est encore exactement l'ancien texte par défaut prend le nouveau ; l'ancien est gardé (previousBody,
 * bodyReplacedAt) et le changement est journalisé. Une clause modifiée à la main n'est jamais touchée ; « actif » et
 * titre restent ceux choisis par Alexandre.
 */
export async function upgradeDefaultClauseTexts(now = new Date()): Promise<number> {
  let replaced = 0;
  const replace = async (row: { id: string; title: string; active: boolean; body: string }, kind: LegalClauseKind, newBody: string, why: string) => {
    // Condition sur le texte dans l'écriture même : une modification faite entre-temps n'est jamais écrasée.
    const done = await prisma.legalClause.updateMany({ where: { id: row.id, body: row.body }, data: { body: newBody, previousBody: row.body, bodyReplacedAt: now } });
    if (done.count === 1) {
      replaced += 1;
      console.info(`[clauses] ${why} : « ${row.title} » (${kind}, ${row.active ? "active" : "inactive"}, ${row.id}) ; ancien texte gardé dans previousBody`);
    }
  };
  for (const { kind, oldBody, newBody } of REPLACED_DEFAULT_BODIES) {
    // Clause supprimée par l'admin : jamais touchée (ni texte, ni état).
    const rows = await prisma.legalClause.findMany({ where: { kind, deletedAt: null }, select: { id: true, title: true, active: true, body: true } });
    for (const row of rows) if (sameText(row.body, oldBody)) await replace(row, kind, newBody, "texte par défaut mis à jour");
  }
  // Clause d'engagement réécrite (production) qui ne connaît pas l'option : la phrase des CGV du 28/10/2026 est ajoutée
  // juste après « à compter de la signature du devis », le reste du texte est gardé tel quel.
  const commitments = await prisma.legalClause.findMany({
    where: { kind: LegalClauseKind.SUBSCRIPTION_COMMITMENT, deletedAt: null },
    select: { id: true, title: true, active: true, body: true },
  });
  for (const row of commitments) {
    const at = row.body.indexOf(COMMITMENT_FROM_SIGNATURE);
    if (at < 0 || /livraison/i.test(row.body)) continue;
    const cut = at + COMMITMENT_FROM_SIGNATURE.length;
    await replace(row, LegalClauseKind.SUBSCRIPTION_COMMITMENT, `${row.body.slice(0, cut)}${OPTION_FROM_DELIVERY}${row.body.slice(cut)}`, "exception de l'option ajoutée");
  }
  // Préavis de non-reconduction (CGV : un mois) : le réglage resté à sa valeur d'origine (la veille) passe à 30 jours.
  const notice = await prisma.companySettings.updateMany({ where: { nonRenewalNoticeDays: 1 }, data: { nonRenewalNoticeDays: 30 } });
  if (notice.count) console.info("[clauses] préavis de non-reconduction des annuels : 1 jour (la veille) porté à 30 jours (CGV)");
  return replaced;
}

/** Comparaison de textes de clause, espaces normalisés (espaces insécables et retours compris). */
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Clause d'engagement : point où insérer l'exception de l'option (CGV du 28/10/2026). */
const COMMITMENT_FROM_SIGNATURE = "Abonnement conclu pour la durée d'engagement indiquée ci-dessus, à compter de la signature du devis";
const OPTION_FROM_DELIVERY = " (pour une option retenue sur un devis payé une fois, à compter de la livraison, date à laquelle l'abonnement démarre)";

/**
 * Devis avec abonnement : phrase de la clause « date de prélèvement » (fiche du devis, e-mail d'envoi),
 * variables remplies. null sans abonnement, pour une facture ou si la clause est désactivée.
 */
export async function subscriptionDateNoticeOf(
  doc: {
    documentType: string;
    lines: ReadonlyArray<{ isSubscription: boolean; isOptional?: boolean; optionalAccepted?: boolean | null; subscriptionStart?: string | null }>;
    legalClausesSnapshot?: unknown;
    billingMode?: string | null;
  },
  clientType: string | null | undefined,
  company: Parameters<typeof fillClauseVariables>[1],
): Promise<string | null> {
  // Comme le PDF (29/10/2026) : un abonnement engagé qui ne démarre pas à la livraison ; jamais pour une seule option.
  // Départ par défaut : la livraison pour un devis mixte (partie ponctuelle hors mode récurrent), sinon la signature.
  const mixed = doc.billingMode !== "RECURRING" && doc.lines.some((l) => !l.isSubscription);
  const dated = doc.lines.some(
    (l) => l.isSubscription && (!l.isOptional || l.optionalAccepted === true) && (l.subscriptionStart ?? (mixed ? "DELIVERY" : "SIGNATURE")) !== "DELIVERY",
  );
  if (doc.documentType !== "QUOTE" || !dated) return null;
  const active = await prisma.legalClause.findMany({
    where: { active: true, kind: LegalClauseKind.SUBSCRIPTION_BILLING_DATE },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  // Devis émis : la clause figée à l'émission.
  const clauses = documentClauses(doc, active).filter((c) => c.kind === LegalClauseKind.SUBSCRIPTION_BILLING_DATE);
  const body = clausesForClient(clauses, clientType)[0]?.body;
  return body ? fillClauseVariables(body, company) : null;
}

/** Public « associations et particuliers » : les non-professionnels (défaut du 26/10/2026, clause de retard du Code civil). */
const NON_PROFESSIONAL_TYPES: ReadonlySet<string> = new Set([ClientType.B2C, ClientType.ASSOCIATION]);

/** Clauses à imprimer pour un client de ce type, selon le public choisi dans Réglages ; type inconnu : « tous » seulement. */
export function clausesForClient<T extends Pick<LegalClause, "audience">>(clauses: T[], clientType: string | null | undefined): T[] {
  return clauses.filter(
    (c) =>
      c.audience === LegalClauseAudience.ALL ||
      c.audience === clientType ||
      (c.audience === LegalClauseAudience.NON_PROFESSIONAL && clientType != null && NON_PROFESSIONAL_TYPES.has(clientType)),
  );
}

/**
 * Devis émis qui ont figé cette clause (même type et même titre) : elle s'y imprime toujours, la suppression est refusée
 * (« désactivez-la »). Comptés dans legalClausesSnapshot, texte JSON sans clé étrangère.
 */
export async function clauseUsageCount(clause: { kind: string; title: string }): Promise<number> {
  const quotes = await prisma.invoice.findMany({
    where: { documentType: "QUOTE", number: { not: null } },
    select: { legalClausesSnapshot: true },
  });
  return quotes.filter((q) => {
    if (q.legalClausesSnapshot == null) return false;
    const parsed = clauseSnapshotSchema.safeParse(q.legalClausesSnapshot);
    return parsed.success && parsed.data.some((c) => c.kind === clause.kind && c.title === clause.title);
  }).length;
}

export async function listActiveLegalClauses() {
  await ensureDefaultLegalClauses();
  return prisma.legalClause.findMany({
    where: { active: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

export async function listAllLegalClauses() {
  await ensureDefaultLegalClauses();
  return prisma.legalClause.findMany({
    where: { deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}
