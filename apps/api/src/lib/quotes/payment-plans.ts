import { MilestoneStatus, type CompanySettings, type Prisma } from "@prisma/client";
import { z } from "zod";
import { computeMilestoneAmounts, type MilestoneTemplate } from "@/lib/quotes/milestones.js";

/** Formule retenue par le client. ONE : comptant (mode ONE_OFF). */
export type PaymentPlan = "ONE" | "TWO" | "THREE";
/**
 * Formule(s) proposée(s) sur le devis. null = échéancier historique (devis émis avant la fonction).
 * NONE = pas de partie ponctuelle : ni acompte ni échéancier, l'abonnement facture chaque période.
 */
export type PaymentPlanOffer = PaymentPlan | "CHOICE" | "NONE";

export const PAYMENT_PLAN_OFFERS: readonly PaymentPlanOffer[] = ["ONE", "TWO", "THREE", "CHOICE"];

export function parsePaymentPlanOffer(value: string | null | undefined): PaymentPlanOffer | null {
  return value === "ONE" || value === "TWO" || value === "THREE" || value === "CHOICE" || value === "NONE" ? value : null;
}

/**
 * Mode de facturation du devis (24/10/2026). ONE_OFF : paiement unique, en parts égales datées depuis la signature.
 * RECURRING : un abonnement seul, au prix annuel ramené à la période (aucune ligne ponctuelle).
 * null : devis antérieur, règles par ligne et échéancier en pourcentages des réglages.
 */
export type BillingMode = "ONE_OFF" | "RECURRING";
export const BILLING_MODES: readonly BillingMode[] = ["ONE_OFF", "RECURRING"];

export function parseBillingMode(value: string | null | undefined): BillingMode | null {
  return value === "ONE_OFF" || value === "RECURRING" ? value : null;
}

/** Devis dont toutes les lignes sont des abonnements : pas d'acompte, pas d'échéancier. */
export function isSubscriptionOnly(lines: ReadonlyArray<{ isSubscription: boolean }>): boolean {
  return lines.length > 0 && lines.every((l) => l.isSubscription);
}

/** Devis sans échéancier (abonnement seul, offre figée à l'émission). */
export function hasNoMilestones(offer: string | null | undefined): boolean {
  return offer === "NONE";
}

export function parsePaymentPlan(value: string | null | undefined): PaymentPlan | null {
  return value === "ONE" || value === "TWO" || value === "THREE" ? value : null;
}

export type PlanSettings = Pick<
  CompanySettings,
  | "depositPercent1Bps"
  | "depositPercent2Bps"
  | "split3Percent1Bps"
  | "split3Percent2Bps"
  | "split3Percent3Bps"
  | "split3MinTotalCents"
  | "split3Step2TriggerText"
  | "installmentIntervalDays"
>;

const scheduleSnapshotSchema = z.object({
  depositPercent1Bps: z.number().int(),
  depositPercent2Bps: z.number().int(),
  split3Percent1Bps: z.number().int(),
  split3Percent2Bps: z.number().int(),
  split3Percent3Bps: z.number().int(),
  split3MinTotalCents: z.number().int(),
  split3Step2TriggerText: z.string(),
  installmentIntervalDays: z.number().int(),
});

/** Réglages d'échéancier figés à l'émission d'un devis (Invoice.paymentScheduleSnapshot, audit du 25/10/2026). */
export function scheduleSnapshotOf(s: PlanSettings): string {
  return JSON.stringify({
    depositPercent1Bps: s.depositPercent1Bps,
    depositPercent2Bps: s.depositPercent2Bps,
    split3Percent1Bps: s.split3Percent1Bps,
    split3Percent2Bps: s.split3Percent2Bps,
    split3Percent3Bps: s.split3Percent3Bps,
    split3MinTotalCents: s.split3MinTotalCents,
    split3Step2TriggerText: s.split3Step2TriggerText,
    installmentIntervalDays: s.installmentIntervalDays,
  } satisfies PlanSettings);
}

/** Échéancier d'un devis émis : réglages figés à son émission ; sans instantané lisible, les réglages actuels. */
export function planSettingsOf<T extends PlanSettings>(doc: { paymentScheduleSnapshot?: string | null }, current: T): T {
  if (!doc.paymentScheduleSnapshot) return current;
  try {
    const parsed = scheduleSnapshotSchema.safeParse(JSON.parse(doc.paymentScheduleSnapshot));
    return parsed.success ? { ...current, ...parsed.data } : current;
  } catch {
    return current;
  }
}

const FIRST_TRIGGER = "À la validation du devis";
const LAST_TRIGGER = "À la livraison / fin de mission";

const installmentCount = (plan: PaymentPlan) => (plan === "ONE" ? 1 : plan === "TWO" ? 2 : 3);

/**
 * Échéancier d'un devis avec mode (24/10/2026) : parts égales, la 1re due à la signature, les suivantes tous les
 * installmentIntervalDays. Pourcentages affichés en parts égales, le reste sur la dernière (3 333, 3 333, 3 334).
 */
function datedTemplate(plan: PaymentPlan, s: Pick<PlanSettings, "installmentIntervalDays">, mode: BillingMode): MilestoneTemplate[] {
  const n = installmentCount(plan);
  const share = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    label: n === 1 ? "Paiement comptant" : `${i === 0 ? "1re" : `${i + 1}e`} échéance`,
    percentBps: i === n - 1 ? 10000 - share * (n - 1) : share,
    triggerText: i === 0 ? "À la signature" : `${i * s.installmentIntervalDays} jours après la signature`,
  }));
}

/**
 * Montants d'un échéancier : parts égales (mode) ou pourcentages ; arrondi au centime, le reste sur la dernière. Parts
 * égales arrondies au centime inférieur (audit du 28/10/2026) : la dernière, qui porte le reste, n'est jamais la plus petite.
 */
export function milestoneAmounts(totalCents: number, template: MilestoneTemplate[], mode: BillingMode | null) {
  if (!mode) return computeMilestoneAmounts(totalCents, template);
  const n = template.length;
  const part = Math.floor(totalCents / n);
  return template.map((m, i) => ({ ...m, amountCents: i === n - 1 ? totalCents - part * (n - 1) : part }));
}

/** Jalons d'une formule : parts égales datées avec un mode, sinon pourcentages et déclencheurs des réglages. */
export function planTemplate(plan: PaymentPlan, s: PlanSettings, mode: BillingMode | null = null): MilestoneTemplate[] {
  if (mode || plan === "ONE") return datedTemplate(plan, s, mode ?? "ONE_OFF");
  if (plan === "THREE") {
    return [
      { position: 1, label: "Acompte", percentBps: s.split3Percent1Bps, triggerText: FIRST_TRIGGER },
      { position: 2, label: "2e acompte", percentBps: s.split3Percent2Bps, triggerText: s.split3Step2TriggerText },
      { position: 3, label: "Solde", percentBps: s.split3Percent3Bps, triggerText: LAST_TRIGGER },
    ];
  }
  return [
    { position: 1, label: "Acompte", percentBps: s.depositPercent1Bps, triggerText: FIRST_TRIGGER },
    { position: 2, label: "Solde", percentBps: s.depositPercent2Bps, triggerText: LAST_TRIGGER },
  ];
}

/**
 * Offre figée à l'émission : sous le seuil du 3 fois, CHOICE et THREE retombent sur TWO,
 * pour que le PDF et l'espace client restent cohérents avec le document émis.
 */
export function effectiveOffer(
  offer: PaymentPlanOffer | null,
  totalCents: number,
  s: Pick<PlanSettings, "split3MinTotalCents">,
): PaymentPlanOffer | null {
  if (offer === null || offer === "ONE" || offer === "TWO" || offer === "NONE") return offer;
  return totalCents < s.split3MinTotalCents ? "TWO" : offer;
}

/**
 * Offre de paiement figée à l'émission d'un devis ou d'une proposition (règle unique de issueQuote et de l'aperçu du
 * brouillon) : aucun échéancier en mode récurrent, pour un abonnement seul ou sans partie ponctuelle ; sinon l'offre
 * demandée, le 3 fois ramené au 2 fois sous le seuil.
 */
export function offerAtIssue(
  mode: BillingMode | null,
  committedLines: ReadonlyArray<{ isSubscription: boolean }>,
  depositBaseCents: number,
  requested: PaymentPlanOffer | null,
  s: Pick<PlanSettings, "split3MinTotalCents">,
): PaymentPlanOffer | null {
  if (mode === "RECURRING" || isSubscriptionOnly(committedLines)) return "NONE";
  // Partie ponctuelle nulle (pack tout en abonnement, remise totale) : pas d'échéancier à 0 €.
  if (committedLines.some((l) => l.isSubscription) && depositBaseCents <= 0) return "NONE";
  return effectiveOffer(requested, depositBaseCents, s);
}

/** Formules que le client peut retenir. */
export function plansOffered(offer: PaymentPlanOffer | null): PaymentPlan[] {
  if (offer === "NONE") return [];
  if (offer === "ONE") return ["ONE"];
  if (offer === "CHOICE") return ["TWO", "THREE"];
  if (offer === "THREE") return ["THREE"];
  return ["TWO"];
}

/** Formule appliquée à l'émission, avant le choix du client : 2 fois sauf offre 3 fois seule. */
export function initialPlan(offer: PaymentPlanOffer | null): PaymentPlan {
  return offer === "THREE" ? "THREE" : offer === "ONE" ? "ONE" : "TWO";
}

/** Échéanciers proposés au client, montants compris (espace client, PDF). */
export function describePlans(offer: PaymentPlanOffer | null, totalCents: number, s: PlanSettings, mode: BillingMode | null = null) {
  return plansOffered(offer).map((plan) => ({
    plan,
    milestones: milestoneAmounts(totalCents, planTemplate(plan, s, mode), mode).map((m) => ({
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
    })),
  }));
}

export class PaymentPlanError extends Error {
  readonly code = "PAYMENT_PLAN";
}

/**
 * Formule retenue à l'acceptation. Offre CHOICE : choix obligatoire depuis l'espace client,
 * 2 fois par défaut ailleurs (admin, messagerie). Une formule non proposée est refusée.
 */
export function resolveAcceptedPlan(
  offer: PaymentPlanOffer | null,
  requested: PaymentPlan | null | undefined,
  opts: { requireChoice: boolean },
): PaymentPlan | null {
  if (offer === "NONE") {
    if (requested) throw new PaymentPlanError("Ce devis d'abonnement n'a pas d'échéancier de paiement.");
    return null;
  }
  const offered = plansOffered(offer);
  if (requested) {
    if (!offered.includes(requested)) {
      throw new PaymentPlanError("Cette formule de paiement n'est pas proposée sur ce devis.");
    }
    return requested;
  }
  if (offer === "CHOICE" && opts.requireChoice) {
    throw new PaymentPlanError("Choisissez le paiement en 2 ou en 3 fois.");
  }
  return initialPlan(offer);
}

/**
 * Remplace l'échéancier par celui de la formule retenue, dans la transaction de l'acceptation.
 * Sûr : aucun jalon n'est facturable ni payable avant la signature (assertQuoteSigned).
 * Ne touche à rien si la formule correspond déjà aux jalons existants.
 */
export async function applyPlanMilestones(
  tx: Prisma.TransactionClient,
  quoteId: string,
  totalCents: number,
  plan: PaymentPlan,
  s: PlanSettings,
  opts: { keepIssued?: boolean; mode?: BillingMode | null } = {},
): Promise<void> {
  const mode = opts.mode ?? null;
  const template = planTemplate(plan, s, mode);
  const existing = await tx.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
  // Signature : l'échéancier imprimé sur le devis émis fait foi. Des pourcentages changés depuis dans les réglages
  // ne le modifient pas ; seule une autre formule (choix du 3 fois) le recalcule.
  if (opts.keepIssued && existing.length === template.length && existing.every((m, i) => m.label === template[i]!.label)) return;
  const amounts = milestoneAmounts(totalCents, template, mode);
  // Montants compris : des jalons créés pendant le brouillon sur une autre base sont recalculés.
  const same =
    existing.length === template.length &&
    existing.every(
      (m, i) =>
        m.percentBps === template[i]!.percentBps && m.label === template[i]!.label && m.amountCents === amounts[i]!.amountCents,
    );
  if (same) return;
  if (existing.some((m) => m.status !== MilestoneStatus.PENDING || m.invoiceId)) {
    throw new PaymentPlanError("L'échéancier de ce devis a déjà commencé : formule non modifiable.");
  }
  await tx.paymentMilestone.deleteMany({ where: { quoteId } });
  await tx.paymentMilestone.createMany({
    data: amounts.map((m) => ({
      quoteId,
      position: m.position,
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
      status: MilestoneStatus.PENDING,
    })),
  });
}

/**
 * Tableau de bord, « À traiter » : devis acceptés en 3 fois dont le 2e acompte attend une étape
 * qui n'est pas encore choisie (garde-fou), et 2e acomptes exigibles encore à facturer.
 */
export async function listDeposit2Todos(db: Prisma.TransactionClient) {
  const quotes = await db.invoice.findMany({
    where: { paymentPlan: "THREE", billingMode: null, milestones: { some: { position: 2, status: { in: [MilestoneStatus.PENDING, MilestoneStatus.DUE] } } } },
    select: {
      id: true,
      number: true,
      client: { select: { displayName: true } },
      project: { select: { steps: true } },
      milestones: { where: { position: 2 }, select: { status: true, invoiceId: true, amountCents: true } },
    },
  });
  const hasTrigger = (steps: string | undefined) => {
    try {
      return (JSON.parse(steps ?? "[]") as Array<{ triggersDeposit2?: boolean }>).some((s) => s.triggersDeposit2);
    } catch {
      return false;
    }
  };
  const row = (q: (typeof quotes)[number]) => ({
    quoteId: q.id,
    number: q.number,
    displayName: q.client.displayName,
    amountCents: q.milestones[0]?.amountCents ?? 0,
  });
  return {
    missingStep: quotes
      .filter((q) => q.milestones[0]?.status === MilestoneStatus.PENDING && !hasTrigger(q.project?.steps))
      .map(row),
    toInvoice: quotes
      .filter((q) => q.milestones[0]?.status === MilestoneStatus.DUE && !q.milestones[0]?.invoiceId)
      .map(row),
  };
}
