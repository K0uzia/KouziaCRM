import { formatEUR } from "@/lib/api";
import { Checkbox, DateInput, Field, Input, Select } from "@/components/ui/Field";
import { discountSentence, OPENING_DISCOUNT, recurringDiscountSummary, type RecurringDiscountSummary } from "@kouzia-erp/recurring-discount";
import { Segmented } from "@/components/ui/Segmented";
import { FREE_MONTHS_MAX, startPhrase, type StartFields, type SubscriptionStart } from "@/lib/subscription-start";
import { equalInstallments, modePlansShown, PERIOD_WORD, periodsIn, type Period, type PlanOffer } from "@/lib/payment-summary";

/**
 * Mode de facturation d'un devis (24/10/2026) : paiement unique (comptant, 2 ou 3 fois en parts égales datées depuis
 * la signature) ou récurrent (un abonnement : période, engagement, départ et jour de prélèvement choisis une fois ;
 * aucune ligne ponctuelle, le prix annuel comprend toute la prestation : décision du 23/10/2026).
 */

export type BillingMode = "ONE_OFF" | "RECURRING";
// Pas d'abonnement sans engagement (décision du 23/10/2026) : 12 mois au minimum, le rythme n'est qu'une façon de payer.
/** Remise du devis récurrent (R1) : case « Remise d'ouverture », ou remise volontaire (pourcentage ou montant par échéance). */
export type RecurringDiscountForm = { opening: boolean; kind: "" | "PERCENT" | "FIXED"; percent: string; euros: string; months: string };
export const NO_DISCOUNT: RecurringDiscountForm = { opening: false, kind: "", percent: "", euros: "", months: "" };
export type RecurringForm = StartFields & { interval: Period; commitmentMonths: "12" | "24" | "36"; billingDay: string; discount: RecurringDiscountForm };

export const DEFAULT_RECURRING: RecurringForm = {
  interval: "YEAR",
  commitmentMonths: "36",
  billingDay: "1",
  subscriptionStart: "",
  subscriptionStartDate: "",
  subscriptionFreeMonths: "",
  discount: NO_DISCOUNT,
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

/** Remise d'un devis enregistré, pour le formulaire. */
export function discountFromDoc(doc: {
  openingDiscount?: boolean | null;
  recurringDiscountKind?: string | null;
  recurringDiscountValue?: number | null;
  recurringDiscountMonths?: number | null;
}): RecurringDiscountForm {
  if (doc.openingDiscount) return { ...NO_DISCOUNT, opening: true };
  if (doc.recurringDiscountKind !== "PERCENT" && doc.recurringDiscountKind !== "FIXED") return NO_DISCOUNT;
  const value = (doc.recurringDiscountValue ?? 0) / 100;
  return {
    opening: false,
    kind: doc.recurringDiscountKind,
    percent: doc.recurringDiscountKind === "PERCENT" ? String(value) : "",
    euros: doc.recurringDiscountKind === "FIXED" ? value.toFixed(2) : "",
    months: doc.recurringDiscountMonths ? String(doc.recurringDiscountMonths) : "",
  };
}

/** Corps de la requête : la case, ou la remise volontaire, ou rien (null retire une remise enregistrée). */
export function discountPayload(d: RecurringDiscountForm) {
  if (d.opening) return { openingDiscount: true, recurringDiscount: null };
  if (!d.kind) return { openingDiscount: false, recurringDiscount: null };
  return {
    openingDiscount: false,
    recurringDiscount: {
      kind: d.kind,
      ...(d.kind === "PERCENT" ? { percent: Number(d.percent.replace(",", ".")) || 0 } : { euros: Number(d.euros.replace(",", ".")) || 0 }),
      months: d.months ? Number(d.months) : null,
    },
  };
}

/** Résumé de la remise (même calcul que l'API et le PDF) ; null sans remise ou incomplète. */
export function discountSummaryOf(value: RecurringForm, periodCents: number): RecurringDiscountSummary | null {
  const d = value.discount;
  const fields = d.opening
    ? { recurringDiscountKind: "PERCENT", recurringDiscountValue: OPENING_DISCOUNT.value, recurringDiscountMonths: OPENING_DISCOUNT.months, openingDiscount: true }
    : {
        recurringDiscountKind: d.kind || null,
        recurringDiscountValue: Math.round(Number((d.kind === "PERCENT" ? d.percent : d.euros).replace(",", ".")) * 100) || null,
        recurringDiscountMonths: d.months ? Number(d.months) : null,
        openingDiscount: false,
      };
  return recurringDiscountSummary(fields, periodCents, value.interval, Number(value.commitmentMonths) || null);
}

/** Phrase de la remise : la même que le PDF (module partagé). */
export const discountPhrase = (d: RecurringDiscountSummary, periodCents: number, interval: Period) => discountSentence(d, periodCents, interval, formatEUR);

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
          ? "Un abonnement au prix annuel, qui comprend toute la prestation, payé à l'année, au trimestre ou au mois."
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
}: {
  value: RecurringForm;
  onChange: (patch: Partial<RecurringForm>) => void;
  periodCents: number;
}) {
  const hasProject = value.subscriptionStart === "DELIVERY";
  const phrase = startPhrase(value, hasProject, periodCents, value.interval);
  const months = Number(value.commitmentMonths) || 0;
  const startChoices: ReadonlyArray<{ id: SubscriptionStart; label: string }> = [
    { id: "", label: "La signature" },
    { id: "DELIVERY", label: "La livraison du projet" },
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
          <Select value={value.commitmentMonths} onChange={(e) => {
            const commitmentMonths = e.target.value as RecurringForm["commitmentMonths"];
            // Remise d'ouverture : 36 mois seulement ; la case se décoche avec un engagement plus court.
            onChange({ commitmentMonths, ...(commitmentMonths !== "36" && value.discount.opening ? { discount: { ...value.discount, opening: false } } : {}) });
          }}>
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
            <DateInput required value={value.subscriptionStartDate} onChange={(v) => onChange({ subscriptionStartDate: v })} />
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
      <DiscountSettings value={value} onChange={onChange} periodCents={periodCents} />
      <p className="text-sm text-[var(--muted)]" aria-live="polite">
        {phrase ? `Sur le devis : « ${phrase} »` : "Complétez la date ou le nombre de mois offerts."}
        {`, engagement de ${months} mois (${periodsIn(months, value.interval)} échéances), puis reconduit chaque année.`}
      </p>
    </div>
  );
}

/**
 * Remise du devis récurrent (R1, décisions du 25/10/2026) : une seule par devis. La remise d'ouverture (30 % sur 12 mois)
 * n'existe qu'avec l'engagement de 36 mois et exclut la remise volontaire.
 */
function DiscountSettings({ value, onChange, periodCents }: { value: RecurringForm; onChange: (patch: Partial<RecurringForm>) => void; periodCents: number }) {
  const d = value.discount;
  const set = (patch: Partial<RecurringDiscountForm>) => onChange({ discount: { ...d, ...patch } });
  const step = value.interval === "YEAR" ? 12 : value.interval === "QUARTER" ? 3 : 1;
  const engaged36 = value.commitmentMonths === "36";
  const summary = discountSummaryOf(value, periodCents);
  return (
    <div className="space-y-3">
      <h4 className={blockTitle}>Remise</h4>
      <Checkbox
        label="Remise d’ouverture : 30 % sur les 12 premiers mois"
        hint={engaged36 ? "Structure créée il y a moins de 12 mois : mention imprimée sur le devis. Pas de cumul avec une autre remise." : "Avec l'engagement de 36 mois seulement."}
        checked={d.opening}
        disabled={!engaged36}
        onChange={(e) => set({ opening: e.target.checked, ...(e.target.checked ? { kind: "" as const } : {}) })}
      />
      {d.opening ? null : (
        <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
          <Field label="Remise volontaire">
            <Select value={d.kind} onChange={(e) => set({ kind: e.target.value as RecurringDiscountForm["kind"] })}>
              <option value="">Aucune</option>
              <option value="PERCENT">Pourcentage</option>
              <option value="FIXED">Montant par échéance</option>
            </Select>
          </Field>
          {d.kind === "PERCENT" ? (
            <Field label="Pourcentage" hint="Entre 0 et 100 %.">
              <Input type="number" inputMode="decimal" min={0} max={99.99} step={0.01} required value={d.percent} onChange={(e) => set({ percent: e.target.value })} />
            </Field>
          ) : null}
          {d.kind === "FIXED" ? (
            <Field label="Montant par échéance (€)" hint="Inférieur au prix d'une échéance.">
              <Input type="number" inputMode="decimal" min={0} step={0.01} required value={d.euros} onChange={(e) => set({ euros: e.target.value })} />
            </Field>
          ) : null}
          {d.kind ? (
            <Field label="Durée (mois)" hint={`Multiple de ${step}, au plus ${value.commitmentMonths}. Vide : toute la durée de l'engagement.`}>
              <Input type="number" inputMode="numeric" min={step} max={Number(value.commitmentMonths)} step={step} value={d.months} onChange={(e) => set({ months: e.target.value })} />
            </Field>
          ) : null}
        </div>
      )}
      {summary ? (
        <p className="text-sm text-[var(--muted)]" aria-live="polite">
          {`Sur le devis : « ${discountPhrase(summary, periodCents, value.interval)} »`}
        </p>
      ) : null}
    </div>
  );
}

/** Récapitulatif d'un devis récurrent : montant par période, engagement et total sur la durée. */
export function RecurringRecap({ value, periodCents }: { value: RecurringForm; periodCents: number }) {
  const months = Number(value.commitmentMonths) || 0;
  const discount = discountSummaryOf(value, periodCents);
  const line = "flex items-baseline justify-between gap-3 text-sm";
  return (
    <div className="space-y-1.5">
      <p className={line}>
        <span className="font-semibold">Abonnement</span>
        <span className="font-display text-2xl font-semibold tabular-nums">
          {formatEUR(periodCents)}
          <span className="text-sm font-normal"> / {PERIOD_WORD[value.interval]}</span>
        </span>
      </p>
      {discount ? <p className="text-xs text-[var(--muted)]">{discountPhrase(discount, periodCents, value.interval)}</p> : null}
      <p className="text-xs text-[var(--muted)]">
        {`Engagement ${months} mois, soit ${formatEUR(discount?.totalCommitmentCents ?? periodCents * periodsIn(months, value.interval))} sur la durée, puis reconduit chaque année.`}
      </p>
    </div>
  );
}
