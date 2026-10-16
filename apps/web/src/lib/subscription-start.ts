import { formatEUR } from "@/lib/format";

/**
 * Départ de la facturation d'une ligne d'abonnement de devis (même règle que l'API, lib/subscriptions/start.ts) :
 * "" = départ par défaut du devis (signature pour un abonnement seul, livraison du projet sinon).
 */
export type SubscriptionStart = "" | "SIGNATURE" | "DELIVERY" | "DATE" | "FREE_MONTHS";
export const FREE_MONTHS_MAX = 24;

export type StartFields = { subscriptionStart: SubscriptionStart; subscriptionStartDate: string; subscriptionFreeMonths: string };

export function startOptions(hasProject: boolean): ReadonlyArray<{ id: SubscriptionStart; label: string }> {
  return [
    { id: "", label: hasProject ? "La livraison du projet" : "La signature" },
    ...(hasProject ? [{ id: "SIGNATURE" as const, label: "La signature" }] : []),
    { id: "DATE", label: "Une date précise" },
    { id: "FREE_MONTHS", label: "Des mois offerts" },
  ];
}

const LONG = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const longDate = (iso: string) => LONG.format(new Date(`${iso}T00:00:00`)).replace(/^1 /, "1er ");

/** Phrase de la ligne : « 12 mois offerts à partir de la livraison du projet, puis 72,00 € par an ». null si incomplète. */
export function startPhrase(f: StartFields, hasProject: boolean, amountCents: number, interval: "MONTH" | "YEAR"): string | null {
  const price = `${formatEUR(amountCents)} par ${interval === "YEAR" ? "an" : "mois"}`;
  if (f.subscriptionStart === "DATE") return f.subscriptionStartDate ? `${price} à partir du ${longDate(f.subscriptionStartDate)}` : null;
  const point = f.subscriptionStart === "SIGNATURE" || !hasProject ? "à partir de la signature" : "à partir de la livraison du projet";
  if (f.subscriptionStart === "FREE_MONTHS") {
    const n = Number(f.subscriptionFreeMonths);
    if (!Number.isInteger(n) || n < 1 || n > FREE_MONTHS_MAX) return null;
    return `${n} mois offert${n > 1 ? "s" : ""} ${point}, puis ${price}`;
  }
  return `${price} ${point}`;
}

/**
 * Ligne comptée dans le total du devis (même règle que l'API, billedWithDocument) : tout sauf un abonnement à 1re
 * facture repoussée (date précise, mois offerts), qui figure seulement dans l'engagement d'abonnement.
 */
export const billedWithDocument = (l: { isSubscription?: boolean | null; subscriptionStart?: string | null }) =>
  !l.isSubscription || (l.subscriptionStart !== "DATE" && l.subscriptionStart !== "FREE_MONTHS");

/** Champs envoyés à l'API : seuls ceux du départ choisi. */
export function startPayload(f: StartFields) {
  return {
    subscriptionStart: f.subscriptionStart || null,
    subscriptionStartDate: f.subscriptionStart === "DATE" ? f.subscriptionStartDate || null : null,
    subscriptionFreeMonths: f.subscriptionStart === "FREE_MONTHS" ? Number(f.subscriptionFreeMonths) || null : null,
  };
}

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Champs du formulaire depuis une ligne enregistrée. */
export function startFromLine(l: { subscriptionStart?: string | null; subscriptionStartDate?: string | null; subscriptionFreeMonths?: number | null }): StartFields {
  const s = (["SIGNATURE", "DELIVERY", "DATE", "FREE_MONTHS"] as const).find((x) => x === l.subscriptionStart);
  return {
    // DELIVERY enregistré = défaut d'un devis avec projet : affiché comme le défaut.
    subscriptionStart: s && s !== "DELIVERY" ? s : "",
    // Date enregistrée à minuit, heure locale : relue en date locale (la chaîne ISO est en UTC, la veille en hiver).
    subscriptionStartDate: l.subscriptionStartDate ? localIso(new Date(l.subscriptionStartDate)) : "",
    subscriptionFreeMonths: l.subscriptionFreeMonths ? String(l.subscriptionFreeMonths) : "",
  };
}
