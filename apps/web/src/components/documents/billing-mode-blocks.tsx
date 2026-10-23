import { formatEUR } from "@/lib/api";
import { Field, Input, Select } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { FREE_MONTHS_MAX, startPhrase, type StartFields, type SubscriptionStart } from "@/lib/subscription-start";
import { equalInstallments, modePlansShown, PERIOD_WORD, periodsIn, type Period, type PlanOffer } from "@/lib/payment-summary";

/**
 * Mode de facturation d'un devis (24/10/2026) : paiement unique (comptant, 2 ou 3 fois en parts égales datées depuis
 * la signature) ou récurrent (un abonnement : période, engagement, départ et jour de prélèvement choisis une fois ;
 * les lignes ponctuelles sont des frais de mise en service dus à la signature).
 */

export type BillingMode = "ONE_OFF" | "RECURRING";
// Pas d'abonnement sans engagement (décision du 23/10/2026) : 12 mois au minimum, le rythme n'est qu'une façon de payer.
export type RecurringForm = StartFields & { interval: Period; commitmentMonths: "12" | "24" | "36"; billingDay: string };

export const DEFAULT_RECURRING: RecurringForm = {
  interval: "YEAR",
  commitmentMonths: "36",
  billingDay: "1",
  subscriptionStart: "",
  subscriptionStartDate: "",
  subscriptionFreeMonths: "",
};

/** Brouillon récurrent rouvert : réglages du document repris de sa 1re ligne d'abonnement (les mêmes sur toutes). */
export function recurringFromLine(
  line: { billingInterval?: string | null; billingDay?: number | null; commitmentMonths?: number | null } & StartFields,
): RecurringForm {
  const interval: Period = line.billingInterval === "QUARTER" || line.billingInterval === "YEAR" ? line.billingInterval : "MONTH";
  const months = line.commitmentMonths;
  return {
    ...DEFAULT_RECURRING,
    interval,
    commitmentMonths: months === 12 || months === 24 || months === 36 ? (String(months) as RecurringForm["commitmentMonths"]) : "12",
    billingDay: String(line.billingDay ?? 1),
    subscriptionStart: line.subscriptionStart,
    subscriptionStartDate: line.subscriptionStartDate,
    subscriptionFreeMonths: line.subscriptionFreeMonths,
  };
}

/** Prix annuel (euros) d'une ligne d'abonnement enregistrée au prix de sa période. */
export const annualEurosOf = (unitPriceCents: number, interval: string | null | undefined) =>
  ((unitPriceCents * (interval === "YEAR" ? 1 : interval === "QUARTER" ? 4 : 12)) / 100).toFixed(2);

const PERIOD_OPTIONS: ReadonlyArray<{ id: Period; label: string }> = [
  { id: "MONTH", label: "Mensuel" },
  { id: "QUARTER", label: "Trimestriel" },
  { id: "YEAR", label: "Annuel" },
];

const blockTitle = "text-sm font-semibold text-[var(--text)]";

export function BillingModeChoice({ value, onChange }: { value: BillingMode | ""; onChange: (next: BillingMode) => void }) {
  return (
    <div className="space-y-1.5">
      <Segmented
        label="Mode de facturation"
        className="w-full max-w-md"
        value={value as BillingMode}
        onChange={onChange}
        options={[
          { id: "ONE_OFF", label: "Paiement unique" },
          { id: "RECURRING", label: "Paiement récurrent" },
        ]}
      />
      <p className="text-xs text-[var(--muted)]">
        {value === "RECURRING"
          ? "Un abonnement au prix annuel ramené à la période ; les lignes libres sont des frais de mise en service, dus à la signature."
          : value === "ONE_OFF"
            ? "Le devis se règle une fois : comptant, ou en 2 ou 3 fois à parts égales."
            : "Devis créé avant le mode de facturation : choisissez-en un pour le mettre à jour."}
      </p>
    </div>
  );
}

/** Paiement unique : formule et échéances datées (parts égales, la 1re à la signature). */
export function OneOffSchedule({
  offer,
  onOffer,
  totalCents,
  intervalDays,
  split3MinTotalCents,
}: {
  offer: PlanOffer;
  onOffer: (next: PlanOffer) => void;
  totalCents: number;
  intervalDays: number;
  split3MinTotalCents: number;
}) {
  const plans = modePlansShown(offer, totalCents, { split3MinTotalCents });
  const belowThreshold = (offer === "THREE" || offer === "CHOICE") && totalCents < split3MinTotalCents;
  return (
    <div className="space-y-3">
      <h4 className={blockTitle}>Échéancier</h4>
      <Field
        className="max-w-xl"
        label="Formule de paiement"
        hint={
          belowThreshold
            ? `Sous ${formatEUR(split3MinTotalCents)}, le devis passera en 2 fois à l'émission.`
            : offer === "CHOICE"
              ? "Le client choisira à la signature ; les deux échéanciers figurent sur le devis."
              : `Parts égales : la 1re à la signature, puis tous les ${intervalDays} jours.`
        }
      >
        <Select value={offer} onChange={(e) => onOffer(e.target.value as PlanOffer)}>
          <option value="ONE">Comptant, à la signature</option>
          <option value="TWO">En 2 fois</option>
          <option value="THREE">En 3 fois</option>
          <option value="CHOICE">Au choix du client (2 ou 3 fois)</option>
        </Select>
      </Field>
      {totalCents > 0 ? (
        <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
          {plans.map((plan) => (
            <dl key={plan} className="space-y-1 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
              <dt className="font-medium">{plan === "ONE" ? "Comptant" : plan === "THREE" ? "En 3 fois" : "En 2 fois"}</dt>
              {equalInstallments(plan, totalCents, intervalDays).map((m) => (
                <dd key={m.label} className="flex items-baseline justify-between gap-3">
                  <span className="text-[var(--muted)]">
                    {m.label}, {m.when}
                  </span>
                  <span className="tabular-nums">{formatEUR(m.amountCents)}</span>
                </dd>
              ))}
            </dl>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Paiement récurrent : période, engagement, départ et jour de prélèvement, pour tout le devis. */
export function RecurringSettings({
  value,
  onChange,
  periodCents,
  feesCents,
}: {
  value: RecurringForm;
  onChange: (patch: Partial<RecurringForm>) => void;
  periodCents: number;
  feesCents: number;
}) {
  const hasProject = feesCents > 0 || value.subscriptionStart === "DELIVERY";
  const phrase = startPhrase(value, hasProject, periodCents, value.interval);
  const months = Number(value.commitmentMonths) || 0;
  const startChoices: ReadonlyArray<{ id: SubscriptionStart; label: string }> = [
    { id: "", label: feesCents > 0 ? "La livraison du projet" : "La signature" },
    ...(feesCents > 0 ? [{ id: "SIGNATURE" as const, label: "La signature" }] : [{ id: "DELIVERY" as const, label: "La livraison du projet" }]),
    { id: "DATE", label: "Une date précise" },
    { id: "FREE_MONTHS", label: "Des mois offerts" },
  ];
  return (
    <div className="space-y-4">
      <h4 className={blockTitle}>Abonnement</h4>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Rythme de paiement" options={PERIOD_OPTIONS} value={value.interval} onChange={(interval) => onChange({ interval })} />
        <span className="text-sm tabular-nums">
          {formatEUR(periodCents)} par {PERIOD_WORD[value.interval]}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
        <Field label="Engagement" hint="Puis reconduit chaque année ; résiliable avec un préavis d'un mois avant l'échéance.">
          <Select value={value.commitmentMonths} onChange={(e) => onChange({ commitmentMonths: e.target.value as RecurringForm["commitmentMonths"] })}>
            <option value="12">12 mois</option>
            <option value="24">24 mois</option>
            <option value="36">36 mois</option>
          </Select>
        </Field>
        <Field label="Facturation à partir de">
          <Select value={value.subscriptionStart} onChange={(e) => onChange({ subscriptionStart: e.target.value as SubscriptionStart })}>
            {startChoices.map((o) => (
              <option key={o.id || "defaut"} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {value.subscriptionStart === "DATE" ? (
          <Field label="Date de la 1re facture">
            <Input type="date" required value={value.subscriptionStartDate} onChange={(e) => onChange({ subscriptionStartDate: e.target.value })} />
          </Field>
        ) : null}
        {value.subscriptionStart === "FREE_MONTHS" ? (
          <Field label="Mois offerts" hint={`1 à ${FREE_MONTHS_MAX}, comptés ${hasProject ? "depuis la livraison" : "depuis la signature"}.`}>
            <Input
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={FREE_MONTHS_MAX}
              value={value.subscriptionFreeMonths}
              onChange={(e) => onChange({ subscriptionFreeMonths: e.target.value })}
            />
          </Field>
        ) : null}
        <Field label="Jour de prélèvement" hint={value.interval === "MONTH" ? "Chaque mois." : "Du mois d'échéance."}>
          <Select value={value.billingDay} onChange={(e) => onChange({ billingDay: e.target.value })}>
            {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-sm text-[var(--muted)]" aria-live="polite">
        {phrase ? `Sur le devis : « ${phrase} »` : "Complétez la date ou le nombre de mois offerts."}
        {`, engagement de ${months} mois (${periodsIn(months, value.interval)} échéances), puis reconduit chaque année.`}
      </p>
    </div>
  );
}

/** Récapitulatif d'un devis récurrent : à la signature, puis par période, engagement et total sur la durée. */
export function RecurringRecap({ value, periodCents, feesCents }: { value: RecurringForm; periodCents: number; feesCents: number }) {
  const months = Number(value.commitmentMonths) || 0;
  const line = "flex items-baseline justify-between gap-3 text-sm";
  return (
    <div className="space-y-1.5">
      {feesCents > 0 ? (
        <p className={line}>
          <span className="text-[var(--muted)]">À la signature (frais de mise en service)</span>
          <span className="tabular-nums">{formatEUR(feesCents)}</span>
        </p>
      ) : null}
      <p className={line}>
        <span className="font-semibold">{feesCents > 0 ? "Ensuite" : "Abonnement"}</span>
        <span className="font-display text-2xl font-semibold tabular-nums">
          {formatEUR(periodCents)}
          <span className="text-sm font-normal"> / {PERIOD_WORD[value.interval]}</span>
        </span>
      </p>
      <p className="text-xs text-[var(--muted)]">
        {`Engagement ${months} mois, soit ${formatEUR(periodCents * periodsIn(months, value.interval))} sur la durée (hors frais de mise en service), puis reconduit chaque année.`}
      </p>
    </div>
  );
}
