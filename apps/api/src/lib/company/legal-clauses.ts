import { LegalClauseAudience, LegalClauseKind, type LegalClause } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export const DEFAULT_LEGAL_CLAUSES: Array<{
  kind: LegalClauseKind;
  title: string;
  body: string;
  required: boolean;
  position: number;
  audience?: LegalClauseAudience;
  /** Créée sur une base neuve (ou par migration) seulement : supprimée par l'admin, elle ne revient pas. */
  seedOnly?: boolean;
}> = [
  {
    kind: LegalClauseKind.VAT,
    title: "Franchise en base de TVA",
    body: "TVA non applicable, art. 293 B du CGI",
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
    audience: LegalClauseAudience.B2C,
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
  // Imprimées dans l'encadré d'abonnement du devis (CGV art. 7.1 à 7.3), selon la périodicité.
  // {{nom_commercial}}, {{email}}, {{adresse}} : remplacés par les réglages au rendu du PDF.
  {
    kind: LegalClauseKind.SUBSCRIPTION_MONTHLY,
    title: "Abonnement mensuel",
    body: "Sans durée minimale. Résiliable à tout moment, sans frais ni justification : la résiliation prend effet à la fin de la période mensuelle en cours, déjà facturée, sans remboursement au prorata. Résiliation en ligne depuis l'espace client (« Gérer mon abonnement » pour un prélèvement, « Résilier mon abonnement » pour un règlement par virement) ou par e-mail à {{email}}.",
    required: true,
    position: 5,
  },
  {
    kind: LegalClauseKind.SUBSCRIPTION_ANNUAL,
    title: "Abonnement annuel",
    body: "Durée d'un an à compter de sa date de départ, payable d'avance, reconduite tacitement pour un an au prix en vigueur. Le client peut refuser la reconduction, sans frais ni justification, jusqu'à la veille de la date de renouvellement ; {{nom_commercial}} l'en informe par e-mail au plus tôt trois mois et au plus tard un mois avant cette date limite (art. L215-1 du Code de la consommation). Non résiliable en cours d'année, sauf manquement de {{nom_commercial}} ou force majeure. Refus de reconduction ou résiliation en ligne depuis l'espace client, ou par e-mail à {{email}}.",
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
];

/** Clauses imprimées dans leur propre bloc du devis, jamais dans la liste des mentions. */
export const DEDICATED_CLAUSE_KINDS: ReadonlySet<LegalClauseKind> = new Set([
  LegalClauseKind.SUBSCRIPTION_MONTHLY,
  LegalClauseKind.SUBSCRIPTION_ANNUAL,
  LegalClauseKind.WITHDRAWAL,
]);

/** E-mail de contact absent des réglages : manque visible sur le document, jamais un blanc. */
export const MISSING_CONTACT_EMAIL = "[e-mail de contact à renseigner dans Réglages]";

/**
 * Variables des clauses, remplacées par les réglages de l'entreprise au rendu. E-mail : celui de
 * l'entreprise, à défaut l'adresse d'envoi des e-mails (celle à laquelle le client répond).
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
  },
): string {
  const address = [company.addressLine1, company.addressLine2, `${company.postalCode} ${company.city}`].filter(Boolean).join(", ");
  // Adresse d'envoi au format « Nom <adresse> » : seule l'adresse est imprimée.
  const smtpAddress = company.smtpFrom?.match(/<([^>]+)>/)?.[1] ?? company.smtpFrom;
  const email = company.email?.trim() || smtpAddress?.trim() || MISSING_CONTACT_EMAIL;
  return body
    .replaceAll("{{nom_commercial}}", company.tradeName ?? company.legalName)
    .replaceAll("{{raison_sociale}}", company.legalName)
    .replaceAll("{{adresse}}", address)
    .replaceAll("{{email}}", email);
}

export async function ensureDefaultLegalClauses() {
  const count = await prisma.legalClause.count();
  if (count === 0) {
    await prisma.legalClause.createMany({
      data: DEFAULT_LEGAL_CLAUSES.map(({ seedOnly: _seedOnly, ...c }) => ({
        ...c,
        active: true,
      })),
    });
    return;
  }

  // Bases déjà seedées : ajouter les clauses manquantes par titre (sans doublon).
  for (const { seedOnly, ...clause } of DEFAULT_LEGAL_CLAUSES) {
    if (seedOnly) continue;
    const existing = await prisma.legalClause.findFirst({
      where: { title: clause.title },
    });
    if (!existing) {
      await prisma.legalClause.create({
        data: { ...clause, active: true },
      });
    }
  }
}

/** Clauses à imprimer pour un client de ce type (B2B ou B2C) ; type inconnu : clauses « tous » seulement. */
export function clausesForClient<T extends Pick<LegalClause, "audience">>(clauses: T[], clientType: string | null | undefined): T[] {
  return clauses.filter((c) => c.audience === LegalClauseAudience.ALL || c.audience === clientType);
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
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}
