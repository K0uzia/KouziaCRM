import { z } from "zod";
import { formatEUR, formatLongDate } from "@/lib/money.js";
import { computeNextInvoiceAt, periodWord } from "@/lib/subscriptions/subscription-service.js";

/**
 * Départ de la facturation d'une ligne d'abonnement de devis (InvoiceLine.subscriptionStart) :
 * - SIGNATURE : dès la signature ; DELIVERY : à la livraison du projet (devis avec projet) ;
 * - DATE : 1re facture au premier jour de prélèvement à partir de subscriptionStartDate ;
 * - FREE_MONTHS : subscriptionFreeMonths mois offerts, comptés depuis le départ par défaut du devis (signature pour un
 *   abonnement seul, livraison pour un projet), puis 1re facture au premier jour de prélèvement suivant.
 * null : départ par défaut du devis (comportement d'avant).
 */
export const SUBSCRIPTION_STARTS = ["SIGNATURE", "DELIVERY", "DATE", "FREE_MONTHS"] as const;
export type SubscriptionStart = (typeof SUBSCRIPTION_STARTS)[number];
export const FREE_MONTHS_MAX = 24;

export type StartLine = {
  subscriptionStart: string | null;
  subscriptionStartDate: Date | null;
  subscriptionFreeMonths: number | null;
};

/** Champs d'entrée d'une ligne (API) : DATE exige une date, FREE_MONTHS un nombre de mois ; le reste est effacé. */
export const lineStartInput = z
  .object({
    subscriptionStart: z.enum(SUBSCRIPTION_STARTS).nullish(),
    subscriptionStartDate: z.coerce.date().nullish(),
    subscriptionFreeMonths: z.int().min(1).max(FREE_MONTHS_MAX).nullish(),
  })
  .refine((l) => l.subscriptionStart !== "DATE" || Boolean(l.subscriptionStartDate), {
    message: "Date de la 1re facture requise",
    path: ["subscriptionStartDate"],
  })
  .refine((l) => l.subscriptionStart !== "FREE_MONTHS" || Boolean(l.subscriptionFreeMonths), {
    message: "Nombre de mois offerts requis",
    path: ["subscriptionFreeMonths"],
  });

/** Valeurs enregistrées sur la ligne : seuls les champs utiles au départ choisi. */
export function normalizeLineStart(l: { subscriptionStart?: string | null; subscriptionStartDate?: Date | null; subscriptionFreeMonths?: number | null }): StartLine {
  const start = (SUBSCRIPTION_STARTS as readonly string[]).includes(l.subscriptionStart ?? "") ? (l.subscriptionStart as SubscriptionStart) : null;
  return {
    subscriptionStart: start,
    subscriptionStartDate: start === "DATE" ? (l.subscriptionStartDate ?? null) : null,
    subscriptionFreeMonths: start === "FREE_MONTHS" ? (l.subscriptionFreeMonths ?? null) : null,
  };
}

/** Point de départ par défaut d'un devis : signature pour un abonnement seul, livraison s'il y a un projet. */
export const defaultStartPoint = (hasProject: boolean): "SIGNATURE" | "DELIVERY" => (hasProject ? "DELIVERY" : "SIGNATURE");

/** Moment où la ligne devient un abonnement : à la signature, ou à la livraison du projet. */
export function activationPoint(line: StartLine, hasProject: boolean): "SIGNATURE" | "DELIVERY" {
  const start = line.subscriptionStart as SubscriptionStart | null;
  if (!hasProject) return "SIGNATURE";
  if (start === "SIGNATURE" || start === "DATE") return "SIGNATURE";
  return "DELIVERY";
}

/**
 * 1re facture d'une ligne au départ particulier (DATE, FREE_MONTHS), au premier jour de prélèvement à partir de la date
 * demandée et jamais avant `base` (moment de l'activation). null : départ habituel (facturée à l'activation).
 */
export function lineFirstInvoiceAt(line: StartLine, billingDay: number, base: Date): Date | null {
  let from: Date | null = null;
  if (line.subscriptionStart === "DATE" && line.subscriptionStartDate) from = line.subscriptionStartDate;
  if (line.subscriptionStart === "FREE_MONTHS" && line.subscriptionFreeMonths) {
    from = new Date(base);
    from.setMonth(from.getMonth() + line.subscriptionFreeMonths);
  }
  if (!from) return null;
  const at = computeNextInvoiceAt(billingDay, from > base ? from : base);
  return at.getTime() > base.getTime() ? at : null;
}

/** Données publiques du départ (contrat de /suivi, subscriptionLines) : startsAt toujours renseigné. */
export function publicStart(line: StartLine, hasProject: boolean): { startsAt: "SIGNATURE" | "DELIVERY" | "DATE"; startsOn?: string; freeMonths?: number } {
  if (line.subscriptionStart === "DATE" && line.subscriptionStartDate) {
    const d = line.subscriptionStartDate;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { startsAt: "DATE", startsOn: iso };
  }
  const point = line.subscriptionStart === "SIGNATURE" || line.subscriptionStart === "DELIVERY" ? line.subscriptionStart : defaultStartPoint(hasProject);
  return {
    startsAt: hasProject ? point : "SIGNATURE",
    ...(line.subscriptionStart === "FREE_MONTHS" && line.subscriptionFreeMonths ? { freeMonths: line.subscriptionFreeMonths } : {}),
  };
}


/**
 * Phrase du départ (devis dans l'ERP, PDF) : « 29,00 € par mois à partir de la livraison du projet »,
 * « 12 mois offerts à partir de la signature, puis 72,00 € par an », « 72,00 € par an à partir du 1er mars 2027 ».
 */
export function startPhrase(line: StartLine, hasProject: boolean, amountCents: number, interval: "MONTH" | "QUARTER" | "YEAR"): string {
  const price = `${formatEUR(amountCents)} par ${periodWord(interval)}`;
  const p = publicStart(line, hasProject);
  const from =
    p.startsAt === "DATE" ? `à partir du ${formatLongDate(line.subscriptionStartDate!)}` : p.startsAt === "DELIVERY" ? "à partir de la livraison du projet" : "à partir de la signature";
  if (p.freeMonths) return `${p.freeMonths} mois offert${p.freeMonths > 1 ? "s" : ""} ${from}, puis ${price}`;
  return `${price} ${from}`;
}
