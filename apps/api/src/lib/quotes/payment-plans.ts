import { MilestoneStatus, type CompanySettings, type Prisma } from "@prisma/client";
import { computeMilestoneAmounts, type MilestoneTemplate } from "@/lib/quotes/milestones.js";

/** Formule retenue par le client. */
export type PaymentPlan = "TWO" | "THREE";
/**
 * Formule(s) proposée(s) sur le devis. null = échéancier historique (devis émis avant la fonction).
 * NONE = devis d'abonnement seul : ni acompte ni échéancier, l'abonnement facture chaque période.
 */
export type PaymentPlanOffer = PaymentPlan | "CHOICE" | "NONE";

export const PAYMENT_PLANS: readonly PaymentPlan[] = ["TWO", "THREE"];
export const PAYMENT_PLAN_OFFERS: readonly PaymentPlanOffer[] = ["TWO", "THREE", "CHOICE"];

export function parsePaymentPlanOffer(value: string | null | undefined): PaymentPlanOffer | null {
  return value === "TWO" || value === "THREE" || value === "CHOICE" || value === "NONE" ? value : null;
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
  return value === "TWO" || value === "THREE" ? value : null;
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
>;

const FIRST_TRIGGER = "À la validation du devis";
const LAST_TRIGGER = "À la livraison / fin de mission";

/** Jalons d'une formule, depuis les réglages (pourcentages et texte du déclencheur). */
export function planTemplate(plan: PaymentPlan, s: PlanSettings): MilestoneTemplate[] {
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
  if (offer === null || offer === "TWO" || offer === "NONE") return offer;
  return totalCents < s.split3MinTotalCents ? "TWO" : offer;
}

/** Formules que le client peut retenir. */
export function plansOffered(offer: PaymentPlanOffer | null): PaymentPlan[] {
  if (offer === "NONE") return [];
  if (offer === "CHOICE") return ["TWO", "THREE"];
  if (offer === "THREE") return ["THREE"];
  return ["TWO"];
}

/** Formule appliquée à l'émission, avant le choix du client : 2 fois sauf offre 3 fois seule. */
export function initialPlan(offer: PaymentPlanOffer | null): PaymentPlan {
  return offer === "THREE" ? "THREE" : "TWO";
}

/** Échéanciers proposés au client, montants compris (espace client, PDF). */
export function describePlans(offer: PaymentPlanOffer | null, totalCents: number, s: PlanSettings) {
  return plansOffered(offer).map((plan) => ({
    plan,
    milestones: computeMilestoneAmounts(totalCents, planTemplate(plan, s)).map((m) => ({
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
): Promise<void> {
  const template = planTemplate(plan, s);
  const existing = await tx.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
  const same =
    existing.length === template.length &&
    existing.every((m, i) => m.percentBps === template[i]!.percentBps && m.label === template[i]!.label);
  if (same) return;
  if (existing.some((m) => m.status !== MilestoneStatus.PENDING || m.invoiceId)) {
    throw new PaymentPlanError("L'échéancier de ce devis a déjà commencé : formule non modifiable.");
  }
  await tx.paymentMilestone.deleteMany({ where: { quoteId } });
  await tx.paymentMilestone.createMany({
    data: computeMilestoneAmounts(totalCents, template).map((m) => ({
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
    where: { paymentPlan: "THREE", milestones: { some: { position: 2, status: { in: [MilestoneStatus.PENDING, MilestoneStatus.DUE] } } } },
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
