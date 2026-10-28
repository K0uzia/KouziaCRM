import { formatEUR } from "@/lib/api";
import { Checkbox, DateInput, Field, Input, Select } from "@/components/ui/Field";
import { discountSentence, OPENING_DISCOUNT, recurringDiscountSummary, type RecurringDiscountSummary } from "@kouzia-erp/recurring-discount";
import { Segmented } from "@/components/ui/Segmented";
import { FREE_MONTHS_MAX, startPhrase, type StartFields, type SubscriptionStart } from "@/lib/subscription-start";
import { billedPeriodsIn, equalInstallments, modePlansShown, PERIOD_WORD, type Period, type PlanOffer } from "@/lib/payment-summary";
import { choiceDiscountSentence, INTERVAL_LABEL, INTERVAL_ORDER, intervalChoiceRows, longestPeriodMonths, type IntervalChoiceRow } from "@kouzia-erp/interval-choice";
import { startOffsetMonths } from "@/lib/payment-summary";

/**
 * Mode de facturation d'un devis (24/10/2026) : paiement unique (comptant, 2 ou 3 fois en parts égales datées depuis
 * la signature) ou récurrent (un abonnement : période, engagement, départ et jour de prélèvement choisis une fois ;
 * aucune ligne ponctuelle, le prix annuel comprend toute la prestation : décision du 23/10/2026).
 */

export type BillingMode = "ONE_OFF" | "RECURRING";
// Pas d'abonnement sans engagement (décision du 23/10/2026) : 12 mois au minimum, le rythme n'est qu'une façon de payer.
/** Remise du devis récurrent (R1) : case « Remise d'ouverture », ou remise volontaire (pourcentage ou montant par échéance). */
export type RecurringDiscountForm = { opening: boolean; kind: "" | "PERCENT" | "FIXED"; percent: string; euros: string; months: string; promoCode: string };
/** Code promo proposé pour ce devis (client et offres) : GET /api/promo-codes/available. */
export type PromoOption = { code: string; kind: "PERCENT" | "FIXED"; value: number; months: number | null; conditionText: string | null };
export const NO_DISCOUNT: RecurringDiscountForm = { opening: false, kind: "", percent: "", euros: "", months: "", promoCode: "" };
/**
 * intervals : rythmes proposés au client (28/10/2026), les trois par défaut ; plusieurs : le client choisit à la signature
 * et les lignes portent le prix annuel (interval vaut alors YEAR). Un seul : interval, comme avant.
 */
export type RecurringForm = StartFields & { interval: Period; intervals: Period[]; commitmentMonths: "12" | "24" | "36"; billingDay: string; discount: RecurringDiscountForm };

export const DEFAULT_RECURRING: RecurringForm = {
  interval: "YEAR",
  intervals: [...INTERVAL_ORDER],
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
  offeredIntervals?: string | null,
): RecurringForm {
  const offered = INTERVAL_ORDER.filter((iv) => (offeredIntervals ?? "").split(",").includes(iv));
  const interval: Period = offered.length > 1 ? "YEAR" : line.billingInterval === "QUARTER" || line.billingInterval === "YEAR" ? line.billingInterval : "MONTH";
  const months = line.commitmentMonths;
  return {
    ...DEFAULT_RECURRING,
    interval,
    intervals: offered.length > 1 ? offered : [interval],
    commitmentMonths: months === 12 || months === 24 || months === 36 ? (String(months) as RecurringForm["commitmentMonths"]) : "12",
    billingDay: String(line.billingDay ?? 1),
    subscriptionStart: line.subscriptionStart,
    subscriptionStartDate: line.subscriptionStartDate,
    subscriptionFreeMonths: line.subscriptionFreeMonths,
  };
}

/** Remise d'un devis enregistré, pour le formulaire. */
export function discountFromDoc(doc: {
  promoCode?: { code: string } | null;
  openingDiscount?: boolean | null;
  recurringDiscountKind?: string | null;
  recurringDiscountValue?: number | null;
  recurringDiscountMonths?: number | null;
}): RecurringDiscountForm {
  if (doc.promoCode?.code) return { ...NO_DISCOUNT, promoCode: doc.promoCode.code };
  if (doc.openingDiscount) return { ...NO_DISCOUNT, opening: true };
  if (doc.recurringDiscountKind !== "PERCENT" && doc.recurringDiscountKind !== "FIXED") return NO_DISCOUNT;
  const value = (doc.recurringDiscountValue ?? 0) / 100;
  return {
    opening: false,
    kind: doc.recurringDiscountKind,
    percent: doc.recurringDiscountKind === "PERCENT" ? String(value) : "",
    euros: doc.recurringDiscountKind === "FIXED" ? value.toFixed(2) : "",
    months: doc.recurringDiscountMonths ? String(doc.recurringDiscountMonths) : "",
    promoCode: "",
  };
}

/** Corps de la requête : la case, ou la remise volontaire, ou rien (null retire une remise enregistrée). */
export function discountPayload(d: RecurringDiscountForm) {
  if (d.promoCode) return { promoCode: d.promoCode, openingDiscount: false, recurringDiscount: null };
  if (d.opening) return { promoCode: null, openingDiscount: true, recurringDiscount: null };
  if (!d.kind) return { promoCode: null, openingDiscount: false, recurringDiscount: null };
  return {
    promoCode: null,
    openingDiscount: false,
    recurringDiscount: {
      kind: d.kind,
      ...(d.kind === "PERCENT" ? { percent: Number(d.percent.replace(",", ".")) || 0 } : { euros: Number(d.euros.replace(",", ".")) || 0 }),
      months: d.months ? Number(d.months) : null,
    },
  };
}

/** Champs de remise du formulaire, comme l'API les enregistrera (code promo, case d'ouverture ou remise volontaire). */
function discountFieldsOf(value: RecurringForm, promos: ReadonlyArray<PromoOption>) {
  const d = value.discount;
  const promo = d.promoCode ? promos.find((p) => p.code === d.promoCode) : undefined;
  if (promo) return { recurringDiscountKind: promo.kind, recurringDiscountValue: promo.value, recurringDiscountMonths: promo.months, openingDiscount: false, promoCode: { code: promo.code, conditionText: promo.conditionText } };
  return d.opening
    ? { recurringDiscountKind: "PERCENT", recurringDiscountValue: OPENING_DISCOUNT.value, recurringDiscountMonths: OPENING_DISCOUNT.months, openingDiscount: true }
    : {
        recurringDiscountKind: d.kind || null,
        recurringDiscountValue: Math.round(Number((d.kind === "PERCENT" ? d.percent : d.euros).replace(",", ".")) * 100) || null,
        recurringDiscountMonths: d.months ? Number(d.months) : null,
        openingDiscount: false,
      };
}

/** Résumé de la remise (même calcul que l'API et le PDF) ; null sans remise ou incomplète. */
export function discountSummaryOf(value: RecurringForm, periodCents: number, promos: ReadonlyArray<PromoOption> = []): RecurringDiscountSummary | null {
  // Échéances facturées pendant l'engagement (mois offerts, 1re facture à une date) : même règle que l'API.
  const billed = billedPeriodsIn(Number(value.commitmentMonths) || 0, value.interval, value);
  return recurringDiscountSummary(discountFieldsOf(value, promos), periodCents, value.interval, Number(value.commitmentMonths) || null, billed);
}

/** Phrase de la remise : la même que le PDF (module partagé). */
export const discountPhrase = (d: RecurringDiscountSummary, periodCents: number, interval: Period) => discountSentence(d, periodCents, interval, formatEUR);

/** Prix annuel (euros) d'une ligne d'abonnement enregistrée au prix de sa période : réciproque de periodPriceOfAnnual. */
export const annualEurosOf = (unitPriceCents: number, interval: string | null | undefined, annualFreeMonths: number) => {
  const paid = 12 - Math.min(11, Math.max(0, annualFreeMonths));
  return (Math.round(interval === "YEAR" ? unitPriceCents : interval === "QUARTER" ? (unitPriceCents * paid) / 3 : unitPriceCents * paid) / 100).toFixed(2);
};

/** Corps de la requête : les rythmes proposés, null pour un seul (le rythme des lignes). */
export const offeredIntervalsPayload = (value: Pick<RecurringForm, "intervals">): Period[] | null =>
  value.intervals.length > 1 ? INTERVAL_ORDER.filter((iv) => value.intervals.includes(iv)) : null;

/** Rythmes cochés : jamais aucun ; le rythme des lignes suit (annuel s'il y en a plusieurs). */
export function toggleInterval(value: Pick<RecurringForm, "intervals">, iv: Period, on: boolean): Pick<RecurringForm, "intervals" | "interval"> {
  const next = INTERVAL_ORDER.filter((x) => (x === iv ? on : value.intervals.includes(x)));
  const intervals = next.length ? next : value.intervals;
  return { intervals, interval: intervals.length === 1 ? intervals[0]! : "YEAR" };
}

/** Rangs du tableau des rythmes (mêmes calculs que le PDF et /suivi), quand plusieurs sont proposés. */
export function intervalRowsOf(value: RecurringForm, annualLineCents: ReadonlyArray<number>, annualFreeMonths: number, promos: ReadonlyArray<PromoOption> = []): IntervalChoiceRow[] {
  if (value.intervals.length < 2) return [];
  return intervalChoiceRows({
    offered: value.intervals,
    annualLineCents,
    annualFreeMonths,
    commitmentMonths: Number(value.commitmentMonths) || null,
    offsetMonths: startOffsetMonths(value),
    discount: discountFieldsOf(value, promos),
  });
}

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
  promos = [],
  annualLineCents = [],
  annualFreeMonths,
}: {
  value: RecurringForm;
  onChange: (patch: Partial<RecurringForm>) => void;
  periodCents: number;
  promos?: ReadonlyArray<PromoOption>;
  /** Prix annuel de chaque ligne d'abonnement : tableau des rythmes au choix. */
  annualLineCents?: ReadonlyArray<number>;
  annualFreeMonths: number;
}) {
  const hasProject = value.subscriptionStart === "DELIVERY";
  const rows = intervalRowsOf(value, annualLineCents, annualFreeMonths, promos);
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
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-[var(--text)]">Rythmes proposés au client</legend>
        <p className="text-xs text-[var(--muted)]">
          {value.intervals.length > 1
            ? "Le client choisit à la signature. Prix saisi : l'annuel ; mensuel = annuel / " + (12 - annualFreeMonths) + ", trimestriel = 3 mensualités."
            : "Un seul rythme : aucun choix à la signature."}
        </p>
        <div className="flex flex-wrap gap-x-5">
          {INTERVAL_ORDER.map((iv) => (
            <Checkbox
              key={iv}
              label={INTERVAL_LABEL[iv]}
              checked={value.intervals.includes(iv)}
              // Au moins un rythme : le dernier coché reste coché.
              disabled={value.intervals.length === 1 && value.intervals[0] === iv}
              onChange={(e) => onChange(toggleInterval(value, iv, e.target.checked))}
            />
          ))}
        </div>
        {rows.length ? (
          <IntervalTable rows={rows} />
        ) : (
          <p className="text-sm tabular-nums">
            {formatEUR(periodCents)} par {PERIOD_WORD[value.interval]}
          </p>
        )}
      </fieldset>
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
        <Field label="Jour de prélèvement" hint={value.intervals.length > 1 ? "Du mois d'échéance, selon le rythme retenu." : value.interval === "MONTH" ? "Chaque mois." : "Du mois d'échéance."}>
          <Select value={value.billingDay} onChange={(e) => onChange({ billingDay: e.target.value })}>
            {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <DiscountSettings value={value} onChange={onChange} periodCents={periodCents} promos={promos} />
      <p className="text-sm text-[var(--muted)]" aria-live="polite">
        {phrase ? `Sur le devis : « ${phrase} »` : "Complétez la date ou le nombre de mois offerts."}
        {value.intervals.length > 1
          ? `, engagement de ${months} mois, puis reconduit chaque année.`
          : `, engagement de ${months} mois (${billedPeriodsIn(months, value.interval, value)} échéances), puis reconduit chaque année.`}
      </p>
    </div>
  );
}

/**
 * Remise du devis récurrent (R1, décisions du 25/10/2026) : une seule par devis. La remise d'ouverture (30 % sur 12 mois)
 * n'existe qu'avec l'engagement de 36 mois et exclut la remise volontaire.
 */
function DiscountSettings({ value, onChange, periodCents, promos }: { value: RecurringForm; onChange: (patch: Partial<RecurringForm>) => void; periodCents: number; promos: ReadonlyArray<PromoOption> }) {
  const d = value.discount;
  const set = (patch: Partial<RecurringDiscountForm>) => onChange({ discount: { ...d, ...patch } });
  const choice = value.intervals.length > 1;
  const step = choice ? longestPeriodMonths(value.intervals) : value.interval === "YEAR" ? 12 : value.interval === "QUARTER" ? 3 : 1;
  const engaged36 = value.commitmentMonths === "36";
  const summary = discountSummaryOf(value, periodCents, promos);
  const promoChosen = Boolean(d.promoCode);
  return (
    <div className="space-y-3">
      <h4 className={blockTitle}>Remise</h4>
      {promos.length || d.promoCode ? (
        <Field label="Code promo" hint={promoChosen ? "Le code fixe la remise : pas de cumul avec une autre remise." : "Codes valables pour ce client et cette offre (Offre, Codes promo)."}>
          <Select value={d.promoCode} onChange={(e) => set({ promoCode: e.target.value, ...(e.target.value ? { opening: false, kind: "" as const } : {}) })}>
            <option value="">Aucun</option>
            {d.promoCode && !promos.some((p) => p.code === d.promoCode) ? <option value={d.promoCode}>{d.promoCode}</option> : null}
            {promos.map((p) => (
              <option key={p.code} value={p.code}>
                {p.code}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {promoChosen ? null : (
      <>
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
              {/* Plusieurs rythmes : un montant par échéance n'aurait pas le même poids d'un rythme à l'autre. */}
              <option value="FIXED" disabled={choice}>{choice ? "Montant par échéance (un seul rythme)" : "Montant par échéance"}</option>
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
      </>
      )}
      {summary ? (
        <p className="text-sm text-[var(--muted)]" aria-live="polite">
          {`Sur le devis : « ${choice ? choiceDiscountSentence(summary) : discountPhrase(summary, periodCents, value.interval)} »`}
        </p>
      ) : null}
    </div>
  );
}

/** Récapitulatif d'un devis récurrent : montant par période, engagement et total sur la durée. */
export function RecurringRecap({
  value,
  periodCents,
  promos = [],
  annualLineCents = [],
  annualFreeMonths,
}: {
  value: RecurringForm;
  periodCents: number;
  promos?: ReadonlyArray<PromoOption>;
  annualLineCents?: ReadonlyArray<number>;
  annualFreeMonths: number;
}) {
  const months = Number(value.commitmentMonths) || 0;
  const discount = discountSummaryOf(value, periodCents, promos);
  const line = "flex items-baseline justify-between gap-3 text-sm";
  const rows = intervalRowsOf(value, annualLineCents, annualFreeMonths, promos);
  if (rows.length) {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-semibold">Abonnement, rythme au choix du client</p>
        <IntervalTable rows={rows} />
        <p className="text-xs text-[var(--muted)]">{`Engagement ${months} mois, puis reconduit chaque année. Le client choisit le rythme à la signature.`}</p>
      </div>
    );
  }
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
        {`Engagement ${months} mois, soit ${formatEUR(discount?.totalCommitmentCents ?? periodCents * billedPeriodsIn(months, value.interval, value))} sur la durée, puis reconduit chaque année.`}
      </p>
    </div>
  );
}

/** Tableau compact des rythmes proposés : prix par échéance et total sur l'engagement (remise comprise). */
function IntervalTable({ rows }: { rows: ReadonlyArray<IntervalChoiceRow> }) {
  return (
    <table className="w-full text-sm tabular-nums">
      <caption className="sr-only">Rythmes proposés au client</caption>
      <thead>
        <tr className="text-xs text-[var(--muted)]">
          <th scope="col" className="py-1.5 pr-2 text-left font-medium">Rythme</th>
          <th scope="col" className="px-2 py-1.5 text-right font-medium">Prix par échéance</th>
          <th scope="col" className="py-1.5 pl-2 text-right font-medium">Total sur l'engagement</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.interval} className="border-t border-[var(--border)]">
            <th scope="row" className="py-1.5 pr-2 text-left font-normal">{INTERVAL_LABEL[r.interval]}</th>
            {/* Le rythme dit la période : montant seul, sans retour à la ligne au téléphone. */}
            <td className="whitespace-nowrap px-2 py-1.5 text-right">{formatEUR(r.amountCents)}</td>
            <td className="whitespace-nowrap py-1.5 pl-2 text-right font-semibold">{r.totalCommitmentCents !== null ? formatEUR(r.totalCommitmentCents) : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Rythmes au choix enregistrés sur un devis ou une proposition (« YEAR,MONTH ») : deux au moins, sinon aucun. */
export function offeredIntervalsOf(value: string | null | undefined): Period[] {
  const list = INTERVAL_ORDER.filter((iv) => (value ?? "").split(",").includes(iv));
  return list.length > 1 ? list : [];
}

/**
 * Signature hors ligne ou validée depuis la messagerie (28/10/2026) : le rythme retenu par le client, obligatoire quand
 * plusieurs sont proposés, sans choix par défaut. Rien à afficher pour un seul rythme.
 */
export function IntervalChoiceFieldset({
  offered,
  value,
  onChange,
  name,
  amounts,
}: {
  offered: string | null | undefined;
  value: Period | "";
  onChange: (next: Period) => void;
  name: string;
  /** Montant d'une échéance par rythme, calculé par l'API (mois offerts figés à l'émission). */
  amounts?: ReadonlyArray<{ interval: string; amountCents: number }> | null;
}) {
  const list = offeredIntervalsOf(offered);
  if (!list.length) return null;
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">Rythme de paiement retenu par le client</legend>
      {list.map((iv) => (
        <label key={iv} className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name={name} required value={iv} checked={value === iv} onChange={() => onChange(iv)} />
          {INTERVAL_LABEL[iv]}
          {(() => {
            const a = amounts?.find((x) => x.interval === iv);
            return a ? <span className="tabular-nums text-[var(--muted)]">{` : ${formatEUR(a.amountCents)} par ${PERIOD_WORD[iv]}`}</span> : null;
          })()}
        </label>
      ))}
    </fieldset>
  );
}
