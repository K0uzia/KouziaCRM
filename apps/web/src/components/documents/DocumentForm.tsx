import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronRight, faPen, faPlus, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { api, formatEUR } from "@/lib/api";
import { offlineEnabled } from "@/lib/offline/config";
import { isLocalClientId, submitCreation, useRequestId } from "@/lib/offline/queue";
import { euros } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { useMediaQuery } from "@/lib/use-media-query";
import { DateInput, Field, Input, Select, Textarea } from "@/components/ui/Field";
import type { Client } from "@/components/clients/ClientForm";
import { pendingNeeds, type ServiceNeed } from "@/components/clients/ServiceNeedsEditor";
import { Segmented } from "@/components/ui/Segmented";
import { Combobox } from "@/components/ui/Combobox";
import { Badge } from "@/components/ui/Card";
import { catalogGroups } from "@/lib/catalog-options";
import { billedWithDocument, FREE_MONTHS_MAX, startFromLine, startOptions, startPayload, startPhrase, type StartFields, type SubscriptionStart } from "@/lib/subscription-start";
import {
  eurosInputToCents,
  INTERVAL_OPTIONS,
  monthlyEquivalentText,
  normalizeInterval,
  periodSuffix,
  suggestedAmountCents,
  type BillingInterval,
} from "@/lib/billing-interval";
import { commitmentTotalCents, equalInstallments, installments, modePlansShown, oneOffMeans, orList, PERIOD_WORD, periodAmountCents, plansShown, subscriptionMeans, type PaymentSettings } from "@/lib/payment-summary";
import { BillingModeChoice, DEFAULT_RECURRING, discountPayload, type PromoOption, OneOffSchedule, RecurringRecap, RecurringSettings, type BillingMode, type RecurringForm } from "@/components/documents/billing-mode-blocks";

export type DocLine = {
  description: string;
  quantity: string;
  unitPriceEuros: string;
  isSubscription: boolean;
  billingDay: string;
  billingInterval: BillingInterval;
  serviceId: string;
  /** Pack : titre sous lequel la ligne est groupée ; ligne de remise du pack (montant négatif). */
  groupTitle?: string;
  isPackDiscount?: boolean;
  /** Abonnement de devis : durée d'engagement en mois (« 12 », « 24 », « 36 ») ; vide = sans engagement. */
  commitmentMonths?: string;
  /** Ligne du catalogue passée en saisie libre (« Modifier le texte ») ; jamais envoyé. */
  editText?: boolean;
  /** Devis récurrent : prix annuel de référence d'une ligne d'abonnement (le prix par période en découle). */
  annualEuros?: string;
  /** Paiement unique : abonnement annuel proposé en option, au choix du client à la signature (28/10/2026). */
  isOptional?: boolean;
  /** Option proposée par un pack du formulaire (jamais envoyé) : en abonnement, le prix annuel du pack la comprend. */
  fromPackId?: string;
} & Partial<StartFields>;

const NO_START: StartFields = { subscriptionStart: "", subscriptionStartDate: "", subscriptionFreeMonths: "" };
const startOf = (l: DocLine): StartFields => ({ ...NO_START, ...Object.fromEntries(Object.entries(l).filter(([k]) => k in NO_START)) });
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export type DocumentFormValues = {
  clientId: string;
  notes: string;
  paymentTerms: string;
  serviceDate: string;
  purchaseOrderRef: string;
  validUntil: string;
  lines: DocLine[];
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountPercent: string;
  discountEuros: string;
  /** Facture : devis signé du client auquel la rattacher (facultatif). */
  sourceQuoteId: string;
  /** Devis : comptant, en 2 fois, en 3 fois ou au choix du client (vide = réglages). */
  paymentPlanOffer: "" | "ONE" | "TWO" | "THREE" | "CHOICE";
  /** Devis : mode de facturation du document ; vide = devis antérieur (règles par ligne). */
  billingMode: "" | BillingMode;
  /** Devis récurrent : période, engagement, départ et jour, pour toutes les lignes d'abonnement. */
  recurring: RecurringForm;
};

/** Devis à 2 propositions (P1) : partie du formulaire propre à chaque proposition ; client, dates et notes sont communs. */
export type ProposalSlice = Pick<DocumentFormValues, "lines" | "discountType" | "discountPercent" | "discountEuros" | "paymentPlanOffer" | "billingMode" | "recurring">;
export type ProposalsInit = { labels: [string, string]; other: Partial<DocumentFormValues> };
const sliceOf = (f: ProposalSlice): ProposalSlice => ({
  lines: f.lines,
  discountType: f.discountType,
  discountPercent: f.discountPercent,
  discountEuros: f.discountEuros,
  paymentPlanOffer: f.paymentPlanOffer,
  billingMode: f.billingMode,
  recurring: f.recurring,
});
const PROPOSAL_LETTERS = ["A", "B"] as const;
/** Nom par défaut d'une proposition, selon son mode (28/10/2026) ; remplacé au changement de mode tant qu'il n'est pas modifié. */
const MODE_LABEL: Record<BillingMode, string> = { ONE_OFF: "Paiement unique", RECURRING: "Abonnement annuel" };
const isDefaultLabel = (label: string) => !label.trim() || Object.values(MODE_LABEL).includes(label) || /^Proposition [AB]$/.test(label);
const COMMITMENTS = ["12", "24", "36"] as const;

type PlanSettings = PaymentSettings & { vatMention?: string; paymentChoiceDefault: boolean; annualFreeMonths?: number; installmentIntervalDays?: number };

/** Prix annuel saisi (euros) ramené à la période, en euros avec deux décimales. */
const periodEuros = (annualEuros: string | undefined, period: RecurringForm["interval"]) =>
  (periodAmountCents(Math.round((Number(annualEuros) || 0) * 100), period) / 100).toFixed(2);
const PERIOD_MONTHS: Record<string, number> = { MONTH: 1, QUARTER: 3, YEAR: 12 };

type QuoteOpt = {
  id: string;
  number: string | null;
  totalCents: number;
  quoteStatus?: string | null;
  lines?: Array<{ description: string }>;
};

type ServiceOpt = {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  isSubscription?: boolean;
  defaultBillingDay?: number;
  billingInterval?: string | null;
  isPack?: boolean;
  category?: string | null;
};

type PackLine = {
  serviceId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  isSubscription: boolean;
  billingInterval: "MONTH" | "YEAR" | null;
  billingDay: number | null;
  groupTitle: string;
  isPackDiscount: boolean;
  /** Paiement unique : abonnement du pack proposé en option (engagement suggéré). */
  commitmentMonths?: number | null;
};

const DEPOSIT_TERMS = "Acompte à la validation du devis, solde à la livraison (voir l'échéancier).";
const SUBSCRIPTION_TERMS = "Abonnement sans acompte : chaque échéance est facturée, par prélèvement ou à réception de la facture.";
const ONE_OFF_TERMS = "Paiement à la signature, ou en plusieurs fois à parts égales selon l'échéancier.";
const PROPOSALS_TERMS = "Paiement selon la proposition retenue, détaillé dans chacune.";
const RECURRING_TERMS = "Abonnement : chaque échéance est facturée, par prélèvement ou à réception de la facture.";

const emptyLine = (): DocLine => ({
  description: "",
  quantity: "1",
  unitPriceEuros: "",
  isSubscription: false,
  billingDay: "1",
  // Annuel par défaut : Stripe prélève des frais à chaque transaction (une par an plutôt que douze).
  billingInterval: "YEAR",
  serviceId: "",
});

export function DocumentFormEditor({
  mode,
  documentType,
  documentId,
  initial,
  initialProposals,
  clients,
  onSuccess,
  onCancel,
}: {
  mode: "create" | "edit";
  documentType: "INVOICE" | "QUOTE";
  documentId?: string;
  initial?: Partial<DocumentFormValues>;
  /** Brouillon à 2 propositions : A dans initial, B ici, avec les deux noms. */
  initialProposals?: ProposalsInit;
  clients: Array<{ id: string; displayName: string; clientNumber?: string | null; serviceNeeds?: ServiceNeed[]; needsDetails?: string; billingDay?: number | null; updatedAt?: string }>;
  /** queued : devis brouillon mis en file hors ligne (id = clientRequestId), pas encore créé. */
  onSuccess: (doc: { id: string; queued?: boolean; clientId?: string }) => void;
  onCancel: () => void;
}) {
  const requestId = useRequestId();
  const [showDoneNeeds, setShowDoneNeeds] = useState(false);
  const [form, setForm] = useState<DocumentFormValues>({
    clientId: initial?.clientId ?? clients[0]?.id ?? "",
    notes: initial?.notes ?? "",
    paymentTerms:
      initial?.paymentTerms ??
      (documentType === "QUOTE"
        ? DEPOSIT_TERMS
        : "Paiement à réception."),
    serviceDate: initial?.serviceDate ?? "",
    purchaseOrderRef: initial?.purchaseOrderRef ?? "",
    validUntil: initial?.validUntil ?? "",
    lines: initial?.lines?.length
      ? initial.lines.map((l) => ({ ...emptyLine(), ...l }))
      : [emptyLine()],
    discountType: initial?.discountType ?? "NONE",
    discountPercent: initial?.discountPercent ?? "",
    discountEuros: initial?.discountEuros ?? "",
    sourceQuoteId: initial?.sourceQuoteId ?? "",
    paymentPlanOffer: initial?.paymentPlanOffer ?? "",
    // Nouveau devis : paiement unique par défaut ; brouillon antérieur au mode : vide jusqu'au choix.
    billingMode: initial?.billingMode ?? (documentType === "QUOTE" && mode === "create" ? "ONE_OFF" : ""),
    recurring: initial?.recurring ?? DEFAULT_RECURRING,
  });
  // Proposition affichée dans le formulaire (active) ; l'autre est gardée à côté, telle quelle.
  const [proposals, setProposals] = useState<{ active: 0 | 1; labels: [string, string]; other: ProposalSlice } | null>(() =>
    initialProposals
      ? {
          active: 0,
          labels: initialProposals.labels,
          other: sliceOf({
            discountType: "NONE",
            discountPercent: "",
            discountEuros: "",
            paymentPlanOffer: "",
            billingMode: "ONE_OFF",
            recurring: DEFAULT_RECURRING,
            ...initialProposals.other,
            lines: initialProposals.other.lines?.length ? initialProposals.other.lines.map((l) => ({ ...emptyLine(), ...l })) : [emptyLine()],
          }),
        }
      : null,
  );
  const [removingProposal, setRemovingProposal] = useState(false);
  const withProposals = Boolean(proposals);
  /** 2e proposition : copie de la première, à adapter (autre mode, autres prestations). Noms selon le mode. */
  function addProposal() {
    const label = form.billingMode ? MODE_LABEL[form.billingMode] : "";
    setProposals({ active: 1, labels: [label || "Proposition A", label || "Proposition B"], other: sliceOf(form) });
  }
  function switchProposal(next: 0 | 1) {
    if (!proposals || next === proposals.active) return;
    const shown = sliceOf(form);
    setForm((f) => ({ ...f, ...proposals.other }));
    setProposals({ ...proposals, active: next, other: shown });
  }
  /** Retire la proposition affichée : l'autre redevient le devis. */
  function removeProposal() {
    if (!proposals) return;
    setForm((f) => ({ ...f, ...proposals.other }));
    setProposals(null);
    setRemovingProposal(false);
  }
  const [planSettings, setPlanSettings] = useState<PlanSettings | null>(null);
  useEffect(() => {
    api<PlanSettings>("/api/settings")
      .then((s) => {
        setPlanSettings(s);
        if (documentType !== "QUOTE") return;
        // Nouveau devis : formule par défaut des réglages.
        setForm((f) => (f.paymentPlanOffer ? f : { ...f, paymentPlanOffer: s.paymentChoiceDefault ? "CHOICE" : "TWO" }));
      })
      .catch(() => undefined);
  }, [documentType]);
  const [busy, setBusy] = useState(false);
  const [services, setServices] = useState<ServiceOpt[]>([]);
  const [signedQuotes, setSignedQuotes] = useState<QuoteOpt[]>([]);

  // Facture : devis signés du client, pour un rattachement facultatif.
  useEffect(() => {
    if (documentType !== "INVOICE" || !form.clientId) {
      setSignedQuotes([]);
      return;
    }
    let alive = true;
    const cid = encodeURIComponent(form.clientId);
    Promise.all([
      api<QuoteOpt[]>(`/api/invoices?type=QUOTE&clientId=${cid}`),
      api<Array<{ id: string; status: string; quoteId?: string | null; sourceQuoteId?: string | null }>>(
        `/api/invoices?type=INVOICE&clientId=${cid}`,
      ),
    ])
      .then(([quotes, invoices]) => {
        // Devis déjà facturés (par une autre facture) : l'API refuserait le rattachement.
        const billed = new Set(
          invoices
            .filter((i) => i.status !== "CANCELLED" && i.id !== documentId)
            .flatMap((i) => [i.quoteId, i.sourceQuoteId])
            .filter(Boolean),
        );
        if (alive) {
          setSignedQuotes(
            quotes.filter(
              (q) => q.number && q.quoteStatus === "ACCEPTED" && (!billed.has(q.id) || q.id === form.sourceQuoteId),
            ),
          );
        }
      })
      .catch(() => alive && setSignedQuotes([]));
    return () => {
      alive = false;
    };
  }, [documentType, form.clientId]);

  async function copyQuoteLines(quoteId: string) {
    try {
      const q = await api<{
        lines?: Array<{
          description: string;
          quantity: number;
          unitPriceCents: number;
          isSubscription?: boolean;
          billingDay?: number | null;
          billingInterval?: string | null;
          serviceId?: string | null;
          subscriptionStart?: string | null;
          subscriptionStartDate?: string | null;
          subscriptionFreeMonths?: number | null;
          commitmentMonths?: number | null;
          optionId?: string | null;
        }>;
        selectedOptionId?: string | null;
      }>(`/api/invoices/${quoteId}`);
      // Devis à propositions : seules les prestations de la proposition retenue.
      const lines = (q.lines ?? []).filter((l) => !l.optionId || l.optionId === q.selectedOptionId).map((l) => ({
        description: l.description,
        quantity: String(l.quantity),
        unitPriceEuros: (l.unitPriceCents / 100).toFixed(2),
        isSubscription: Boolean(l.isSubscription),
        billingDay: String(l.billingDay ?? 1),
        billingInterval: normalizeInterval(l.billingInterval),
        serviceId: l.serviceId ?? "",
        commitmentMonths: l.commitmentMonths ? String(l.commitmentMonths) : "",
        ...startFromLine(l),
      }));
      if (lines.length) setForm((f) => ({ ...f, lines }));
      toast.success("Prestations du devis reprises");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reprise impossible");
    }
  }

  useEffect(() => {
    if (!form.clientId && clients[0]) {
      setForm((f) => ({ ...f, clientId: clients[0].id }));
    }
  }, [clients, form.clientId]);

  useEffect(() => {
    api<ServiceOpt[]>("/api/services?active=1")
      .then(setServices)
      .catch(() => setServices([]));
  }, []);

  function updateLine(index: number, patch: Partial<DocLine>) {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  }

  /** Pack : ses prestations détaillées à leur prix, groupées sous son titre, puis la remise du pack. */
  async function addPack(packId: string) {
    try {
      const clientDay = clients.find((c) => c.id === form.clientId)?.billingDay;
      const packLines = await api<PackLine[]>(`/api/services/${packId}/pack-lines`);
      const added: DocLine[] = packLines.map((p) => ({
        // Lien au catalogue gardé (texte affiché tel quel) ; la remise du pack reste une ligne libre.
        serviceId: p.isPackDiscount ? "" : p.serviceId,
        description: p.description,
        quantity: String(p.quantity),
        unitPriceEuros: (p.unitPriceCents / 100).toFixed(2),
        isSubscription: p.isSubscription,
        billingDay: String(clientDay ?? p.billingDay ?? 1),
        billingInterval: p.billingInterval === "YEAR" ? "YEAR" : "MONTH",
        groupTitle: p.groupTitle,
        isPackDiscount: p.isPackDiscount,
      }));
      setForm((f) => {
        const kept = f.lines.filter((l) => l.description.trim() || l.unitPriceEuros);
        return { ...f, lines: [...kept, ...added] };
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pack indisponible");
    }
  }

  const quoteMode = documentType === "QUOTE" ? form.billingMode : "";
  const scopeServiceIds = [...new Set(form.lines.map((l) => l.serviceId).filter(Boolean))].join(",");
  // Codes promo valables pour ce client et ces offres (R3) : proposés dans le bloc Remise d'un devis récurrent.
  const [promos, setPromos] = useState<PromoOption[]>([]);
  const promoServices = form.lines.filter((l) => l.isSubscription && l.serviceId).map((l) => l.serviceId).join(",");
  useEffect(() => {
    if (quoteMode !== "RECURRING" || !form.clientId) {
      setPromos([]);
      return;
    }
    let cancelled = false;
    const q = new URLSearchParams({ clientId: form.clientId, serviceIds: promoServices, ...(documentId ? { invoiceId: documentId } : {}) });
    api<{ codes: PromoOption[] }>(`/api/promo-codes/available?${q.toString()}`)
      .then((r) => !cancelled && setPromos(r.codes))
      .catch(() => !cancelled && setPromos([]));
    return () => {
      cancelled = true;
    };
  }, [quoteMode, form.clientId, promoServices, documentId]);

  /** Prix annuel d'un abonnement du catalogue (prix mensuel × 12). */
  const annualOfService = (svc: ServiceOpt) => (svc.billingInterval === "YEAR" ? svc.unitPriceCents : svc.unitPriceCents * 12);

  /** Ligne d'abonnement d'un devis récurrent : prix annuel saisi, prix de la période en découle. */
  const recurringLine = (base: Omit<DocLine, "unitPriceEuros" | "isSubscription" | "billingInterval">, annualCents: number, period = form.recurring.interval): DocLine => {
    const annualEuros = (annualCents / 100).toFixed(2);
    return { ...base, isSubscription: true, billingInterval: period as BillingInterval, annualEuros, unitPriceEuros: periodEuros(annualEuros, period) };
  };

  /**
   * Paiement unique : abonnement annuel en option, au choix du client à la signature (28/10/2026). Prix annuel du
   * catalogue, modifiable ; engagement 12 mois par défaut ; départ à la livraison (fixé par l'API).
   */
  const optionalLine = (base: Omit<DocLine, "unitPriceEuros" | "isSubscription" | "billingInterval">, annualCents: number): DocLine => ({
    ...base,
    ...NO_START,
    isSubscription: true,
    isOptional: true,
    billingInterval: "YEAR",
    annualEuros: undefined,
    unitPriceEuros: (annualCents / 100).toFixed(2),
    commitmentMonths: COMMITMENTS.includes(base.commitmentMonths as (typeof COMMITMENTS)[number]) ? base.commitmentMonths : "12",
  });

  /**
   * Pack d'un devis avec mode : la ligne « Nom : contenu », au prix d'achat ou au prix annuel. Paiement unique : l'API
   * propose aussi les abonnements du pack, ajoutés en option au choix du client.
   */
  async function packModeLines(packId: string, next: BillingMode): Promise<DocLine[]> {
    const lines = await api<PackLine[]>(`/api/services/${packId}/pack-lines?mode=${next}&interval=YEAR`);
    if (!lines.length) throw new Error("Pack indisponible");
    return lines.map((p) => {
      const base = { serviceId: p.serviceId, description: p.description, quantity: "1", billingDay: String(p.billingDay ?? form.recurring.billingDay) };
      if (next === "RECURRING") return recurringLine(base, p.unitPriceCents);
      if (p.isSubscription) return { ...optionalLine({ ...base, commitmentMonths: p.commitmentMonths ? String(p.commitmentMonths) : "12" }, p.unitPriceCents), fromPackId: packId };
      return { ...emptyLine(), ...base, unitPriceEuros: (p.unitPriceCents / 100).toFixed(2) };
    });
  }

  function placeLines(added: DocLine[]) {
    setForm((f) => {
      let lines = f.lines;
      for (const line of added) {
        const emptyIndex = lines.findIndex((l) => !l.description.trim() && !l.unitPriceEuros);
        lines = emptyIndex >= 0 ? lines.map((l, i) => (i === emptyIndex ? line : l)) : [...lines, line];
      }
      return { ...f, lines };
    });
  }
  const placeLine = (line: DocLine) => placeLines([line]);

  /**
   * Changement de mode : packs repris au bon prix (achat ou annuel), abonnements gardés en récurrent et passés en option
   * au choix du client en paiement unique (28/10/2026), lignes ponctuelles retirées en récurrent (le prix annuel
   * comprend toute la prestation), dit au toast.
   */
  async function switchBillingMode(next: BillingMode) {
    if (next === form.billingMode) return;
    const out: DocLine[] = [];
    const dropped: string[] = [];
    const optional: string[] = [];
    let recurring = form.recurring;
    // Brouillon antérieur passé en récurrent : période de sa 1re ligne d'abonnement.
    const firstSub = form.lines.find((l) => l.isSubscription);
    if (next === "RECURRING" && form.billingMode === "" && firstSub) {
      recurring = { ...recurring, interval: firstSub.billingInterval === "MONTH" ? "MONTH" : "YEAR" };
    }
    for (const l of form.lines) {
      const svc = services.find((x) => x.id === l.serviceId);
      // Option venue d'un pack encore au devis : en abonnement, le prix annuel du pack la comprend déjà.
      if (next === "RECURRING" && l.fromPackId && form.lines.some((x) => x.serviceId === l.fromPackId)) continue;
      if (svc?.isPack) {
        try {
          out.push(...(await packModeLines(svc.id, next)));
        } catch (e) {
          if (next === "RECURRING") toast.warning(e instanceof Error ? e.message : `« ${svc.name} » : pas de prix annuel, retiré du devis.`);
          dropped.push(svc.name);
        }
        continue;
      }
      if (l.isSubscription || svc?.isSubscription) {
        const annualCents = l.annualEuros
          ? Math.round(Number(l.annualEuros) * 100)
          : l.isOptional
            ? Math.round((Number(l.unitPriceEuros) || 0) * 100)
            : svc
              ? annualOfService(svc)
              : Math.round((Number(l.unitPriceEuros) || 0) * 100 * (12 / (PERIOD_MONTHS[l.billingInterval] ?? 1)));
        if (next === "ONE_OFF") {
          // Option seulement pour un abonnement du catalogue (l'abonnement créé à la livraison y est lié).
          if (!l.serviceId) {
            dropped.push(l.description.split(" : ")[0]!);
            continue;
          }
          out.push(optionalLine(l, annualCents));
          optional.push(svc?.name ?? l.description.split(" : ")[0]!);
          continue;
        }
        out.push(recurringLine({ ...l, isOptional: false }, annualCents, recurring.interval));
        continue;
      }
      if (next === "RECURRING" && l.description.trim()) {
        dropped.push(svc?.name ?? l.description.split(" : ")[0]!);
        continue;
      }
      out.push(l);
    }
    // Proposition au nom par défaut : il suit le mode (« Paiement unique », « Abonnement annuel »).
    if (proposals && isDefaultLabel(proposals.labels[proposals.active])) {
      const labels: [string, string] = [...proposals.labels];
      labels[proposals.active] = MODE_LABEL[next];
      setProposals({ ...proposals, labels });
    }
    setForm((f) => ({
      ...f,
      billingMode: next,
      recurring,
      lines: out.length ? out : [emptyLine()],
      paymentPlanOffer: next === "ONE_OFF" && (f.paymentPlanOffer === "" || f.paymentPlanOffer === "ONE") ? f.paymentPlanOffer || "TWO" : f.paymentPlanOffer,
      // Remise : seulement sur une partie ponctuelle, absente en récurrent.
      ...(next === "RECURRING" ? { discountType: "NONE" as const } : {}),
    }));
    if (optional.length) {
      toast.info(`Paiement unique : ${optional.join(", ")} en option, au choix du client à la signature.`);
    }
    if (dropped.length) {
      toast.info(
        next === "ONE_OFF"
          ? `Paiement unique : retiré (${dropped.join(", ")}), faute de prestation du catalogue pour le proposer en option.`
          : `Paiement récurrent : retiré (${dropped.join(", ")}). Le prix annuel comprend toute la prestation.`,
      );
    }
  }

  /** Réglages du récurrent ; une autre période recalcule le prix de chaque ligne d'abonnement. */
  function setRecurring(patch: Partial<RecurringForm>) {
    setForm((f) => {
      const recurring = { ...f.recurring, ...patch };
      const lines =
        patch.interval && patch.interval !== f.recurring.interval
          ? f.lines.map((l) =>
              l.isSubscription ? { ...l, billingInterval: recurring.interval as BillingInterval, unitPriceEuros: periodEuros(l.annualEuros, recurring.interval) } : l,
            )
          : f.lines;
      return { ...f, recurring, lines };
    });
  }

  function addFromCatalog(serviceId: string) {
    const svc = services.find((x) => x.id === serviceId);
    if (!svc) return;
    if (quoteMode) {
      if (svc.isPack) {
        packModeLines(serviceId, quoteMode)
          .then(placeLines)
          .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Pack indisponible"));
        return;
      }
      if (svc.isSubscription && quoteMode === "ONE_OFF") {
        // Paiement unique : un abonnement entre en option, au choix du client à la signature (28/10/2026).
        placeLine(
          optionalLine(
            { serviceId, description: svc.description ? `${svc.name} : ${svc.description}` : svc.name, quantity: "1", billingDay: String(clients.find((c) => c.id === form.clientId)?.billingDay ?? svc.defaultBillingDay ?? 1) },
            annualOfService(svc),
          ),
        );
        toast.info(`« ${svc.name} » ajouté en option : le client la retient ou non à la signature.`);
        return;
      }
      if (!svc.isSubscription && quoteMode === "RECURRING") {
        toast.warning(`« ${svc.name} » se vend en paiement unique : en paiement récurrent, le prix annuel comprend toute la prestation.`);
        return;
      }
      if (svc.isSubscription) {
        placeLine(
          recurringLine(
            { serviceId, description: svc.description ? `${svc.name} : ${svc.description}` : svc.name, quantity: "1", billingDay: form.recurring.billingDay },
            annualOfService(svc),
          ),
        );
        return;
      }
    }
    if (svc.isPack) return void addPack(serviceId);
    const isSub = Boolean(svc.isSubscription);
    // Jour de prélèvement : celui de la fiche client, sinon celui de l'offre.
    const clientDay = clients.find((c) => c.id === form.clientId)?.billingDay;
    const line: DocLine = {
      serviceId,
      description: svc.description ? `${svc.name} : ${svc.description}` : svc.name,
      unitPriceEuros: (svc.unitPriceCents / 100).toFixed(2),
      isSubscription: isSub,
      billingDay: String(clientDay ?? svc.defaultBillingDay ?? 1),
      billingInterval: normalizeInterval(svc.billingInterval),
      quantity: "1",
    };
    setForm((f) => {
      const emptyIndex = f.lines.findIndex((l) => !l.description.trim() && !l.unitPriceEuros);
      const lines = emptyIndex >= 0 ? f.lines.map((l, i) => (i === emptyIndex ? line : l)) : [...f.lines, line];
      return { ...f, lines };
    });
  }

  /** Mensuel ou annuel : prix repris de l'offre, moins les mois offerts des réglages en annuel. */
  function changeLineInterval(index: number, next: BillingInterval) {
    const line = form.lines[index];
    if (!line || line.billingInterval === next) return;
    const svc = services.find((x) => x.id === line.serviceId);
    const freeMonths = planSettings?.annualFreeMonths ?? 2;
    const cents = svc
      ? suggestedAmountCents(svc.unitPriceCents, svc.billingInterval, next, freeMonths)
      : suggestedAmountCents(Math.round((Number(line.unitPriceEuros) || 0) * 100), line.billingInterval, next, freeMonths);
    updateLine(index, { billingInterval: next, unitPriceEuros: (cents / 100).toFixed(2) });
  }

  function addLine() {
    setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }));
  }

  function removeLine(index: number) {
    setForm((f) => ({
      ...f,
      lines: f.lines.length <= 1 ? f.lines : f.lines.filter((_, i) => i !== index),
    }));
  }

  // Option au choix du client : hors du total, montrée à part (« avec l'option »).
  const optionalLines = documentType === "QUOTE" ? form.lines.filter((l) => l.isOptional) : [];
  const optionalYearCents = optionalLines.reduce((s, l) => s + eurosInputToCents(l.unitPriceEuros), 0);
  const subtotalPreview = form.lines.reduce((sum, l) => {
    if (documentType === "QUOTE" && (!billedWithDocument(l) || l.isOptional)) return sum;
    const q = l.isSubscription ? 1 : Number(l.quantity) || 0;
    const p = Number(l.unitPriceEuros) || 0;
    return sum + q * p;
  }, 0);

  // Remise sur la partie ponctuelle seulement : la 1re période d'un abonnement reste au prix prélevé ensuite.
  const oneOffSubtotal = form.lines.reduce(
    (sum, l) => (l.isSubscription ? sum : sum + (Number(l.quantity) || 0) * (Number(l.unitPriceEuros) || 0)),
    0,
  );
  const discountPreview =
    form.discountType === "PERCENT"
      ? Math.min(oneOffSubtotal, (oneOffSubtotal * (Number(form.discountPercent) || 0)) / 100)
      : form.discountType === "FIXED"
        ? Math.min(oneOffSubtotal, Number(form.discountEuros) || 0)
        : 0;

  const totalPreview = Math.max(0, subtotalPreview - discountPreview);
  // Devis d'abonnement seul : ni acompte ni échéancier, l'abonnement facture chaque période.
  const filledLines = form.lines.filter((l) => (l.description.trim() || l.serviceId) && !l.isOptional);
  const subscriptionOnly = documentType === "QUOTE" && filledLines.length > 0 && filledLines.every((l) => l.isSubscription);
  // Devis mixte : acompte et échéancier sur la partie ponctuelle ; l'abonnement démarre à la livraison.
  const mixedQuote =
    documentType === "QUOTE" && filledLines.some((l) => l.isSubscription) && filledLines.some((l) => !l.isSubscription);
  // Base de l'acompte : partie ponctuelle, remise entière déduite (comme computeDepositBaseCents).
  const oneOffPreview = Math.max(0, oneOffSubtotal - discountPreview);
  // Conditions par défaut : suivent la nature du devis tant qu'elles n'ont pas été modifiées.
  // Devis avec mode : texte propre au mode, remplacé seulement s'il est encore l'un des textes par défaut.
  useEffect(() => {
    setForm((f) => {
      const defaults = [DEPOSIT_TERMS, SUBSCRIPTION_TERMS, ONE_OFF_TERMS, RECURRING_TERMS, PROPOSALS_TERMS];
      if (!defaults.includes(f.paymentTerms)) return f;
      const next =
        withProposals ? PROPOSALS_TERMS : f.billingMode === "ONE_OFF" ? ONE_OFF_TERMS : f.billingMode === "RECURRING" ? RECURRING_TERMS : subscriptionOnly ? SUBSCRIPTION_TERMS : DEPOSIT_TERMS;
      return next === f.paymentTerms ? f : { ...f, paymentTerms: next };
    });
  }, [subscriptionOnly, form.billingMode, withProposals]);

  /** Corps de la création (et de l'aperçu, qui reçoit le même brouillon) ; src : la proposition, le formulaire par défaut. */
  function requestBody(lines: DocLine[], src: ProposalSlice = form) {
    const quoteMode = documentType === "QUOTE" ? src.billingMode : "";
    return {
      clientId: form.clientId,
      documentType,
      notes: form.notes || null,
      paymentTerms: form.paymentTerms || null,
      serviceDate: documentType === "INVOICE" ? form.serviceDate || null : null,
      purchaseOrderRef: form.purchaseOrderRef || null,
      ...(documentType === "INVOICE" ? { sourceQuoteId: form.sourceQuoteId || null } : {}),
      // Mode récurrent : l'API fixe l'offre (frais en une fois) ; sans mode : règles par ligne d'avant.
      ...(documentType === "QUOTE" && src.paymentPlanOffer && quoteMode !== "RECURRING" ? { paymentPlanOffer: src.paymentPlanOffer } : {}),
      ...(quoteMode ? { billingMode: quoteMode } : {}),
      // Devis récurrent : la remise (case ou volontaire) ; null retire une remise enregistrée.
      ...(documentType === "QUOTE" && quoteMode === "RECURRING" ? discountPayload(src.recurring.discount) : {}),
      discountType: src.discountType,
      discountPercent:
        src.discountType === "PERCENT" ? Number(src.discountPercent) || 0 : undefined,
      discountEuros:
        src.discountType === "FIXED" ? Number(src.discountEuros) || 0 : undefined,
      lines: lines.map((l) =>
        quoteMode === "ONE_OFF" && l.isOptional
          ? {
              // Option : abonnement annuel, engagement choisi, départ à la livraison fixé par l'API.
              description: l.description,
              quantity: 1,
              unitPriceEuros: Number(l.unitPriceEuros),
              isSubscription: true,
              isOptional: true,
              billingDay: Number(l.billingDay) || 1,
              billingInterval: "YEAR",
              serviceId: l.serviceId || null,
              groupTitle: l.groupTitle?.trim() || null,
              isPackDiscount: false,
              commitmentMonths: Number(l.commitmentMonths) || 12,
            }
          : quoteMode === "RECURRING" && l.isSubscription
          ? {
              // Récurrent : période, engagement, départ et jour du document, les mêmes sur chaque ligne.
              description: l.description,
              quantity: 1,
              unitPriceEuros: Number(periodEuros(l.annualEuros, src.recurring.interval)),
              isSubscription: true,
              billingDay: Number(src.recurring.billingDay) || 1,
              billingInterval: src.recurring.interval,
              serviceId: l.serviceId || null,
              groupTitle: null,
              isPackDiscount: false,
              ...startPayload(src.recurring),
              commitmentMonths: src.recurring.commitmentMonths ? Number(src.recurring.commitmentMonths) : null,
            }
          : {
              description: l.description,
              quantity: l.isSubscription ? 1 : Number(l.quantity),
              unitPriceEuros: Number(l.unitPriceEuros),
              isSubscription: l.isSubscription,
              billingDay: l.isSubscription ? Number(l.billingDay) || 1 : null,
              billingInterval: l.isSubscription ? l.billingInterval : null,
              serviceId: l.serviceId || null,
              groupTitle: l.groupTitle?.trim() || null,
              isPackDiscount: Boolean(l.isPackDiscount),
              ...(documentType === "QUOTE" && l.isSubscription
                ? { ...startPayload(startOf(l)), commitmentMonths: l.commitmentMonths ? Number(l.commitmentMonths) : null }
                : {}),
            },
      ),
    };
  }

  /**
   * Corps envoyé : devis simple, ou partie commune et les 2 propositions dans l'ordre A, B (leurs réglages de facturation
   * ne vont jamais sur le devis lui-même). Brouillon qui en avait : null les retire.
   */
  function submitBody() {
    const body = requestBody(form.lines);
    if (!proposals) return initialProposals && mode === "edit" ? { ...body, options: null } : body;
    const { clientId, notes, paymentTerms, serviceDate, purchaseOrderRef } = body;
    const slices = proposals.active === 0 ? [sliceOf(form), proposals.other] : [proposals.other, sliceOf(form)];
    return {
      clientId,
      documentType,
      notes,
      paymentTerms,
      serviceDate,
      purchaseOrderRef,
      options: slices.map((s, i) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { clientId: _c, documentType: _t, notes: _n, paymentTerms: _p, serviceDate: _s, purchaseOrderRef: _o, ...billing } = requestBody(s.lines, s);
        return { label: proposals.labels[i]!.trim() || `Proposition ${PROPOSAL_LETTERS[i]}`, ...billing };
      }),
    };
  }

  // Aperçu (D3) : dans le récapitulatif dès 1280 px, où il garde une largeur lisible ; en dessous, fenêtre à la demande
  // (requêtes seulement si elle est ouverte).
  const widePreview = useMediaQuery("(min-width: 80rem)");
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewLines = form.lines.filter((l) => l.description.trim() || l.unitPriceEuros.trim());
  const previewBody = useMemo(
    () =>
      form.clientId && !isLocalClientId(form.clientId) && (proposals || previewLines.length > 0)
        ? JSON.stringify(proposals ? submitBody() : requestBody(previewLines))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, documentType, proposals],
  );
  const previewPaused = !form.clientId
    ? "Choisissez un client pour voir l'aperçu."
    : isLocalClientId(form.clientId)
      ? "Aperçu disponible une fois le client créé, au retour du réseau."
    : "Ajoutez une prestation pour voir l'aperçu.";
  const previewKind = documentType === "QUOTE" ? "Devis" : "Facture";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.clientId) {
      toast.error("Choisissez le client");
      return;
    }
    for (const l of [...form.lines, ...(proposals?.other.lines ?? [])]) {
      if (l.isSubscription && !l.serviceId) {
        toast.error("Chaque ligne abonnement doit être liée à une prestation");
        return;
      }
    }
    setBusy(true);
    try {
      const body = submitBody();
      if (mode === "create" && documentType === "QUOTE" && offlineEnabled()) {
        // Origine du hors ligne : devis brouillon mis en file hors ligne (jamais émis ni numéroté), sinon envoyé
        // directement ; ce que l'appareil a vu (fiche client, prix catalogue) permet de signaler un écart.
        const { clientId, ...rest } = body;
        const client = clients.find((c) => c.id === clientId);
        const servicePricesSeen = form.lines.flatMap((l) => {
          const svc = l.serviceId ? services.find((x) => x.id === l.serviceId) : undefined;
          return svc ? [{ serviceId: svc.id, unitPriceCents: svc.unitPriceCents }] : [];
        });
        const name = client?.displayName ?? "client";
        const result = await submitCreation<{ id: string }>({
          kind: "quote",
          label: `Devis pour ${name}, ${formatEUR(Math.round(totalPreview * 100))}`,
          clientId,
          clientName: name,
          body: { ...rest, clientSeenUpdatedAt: isLocalClientId(clientId) ? null : (client?.updatedAt ?? null), servicePricesSeen },
          requestId: requestId.current,
        });
        requestId.renew();
        if (result.queued) {
          toast.success("Devis brouillon préparé hors ligne : il partira au retour du réseau.");
          onSuccess({ id: result.item.id, queued: true, clientId });
        } else {
          toast.success("Devis créé");
          onSuccess(result.data);
        }
        return;
      }
      const doc = await api<{ id: string }>(
        mode === "edit" && documentId ? `/api/invoices/${documentId}` : "/api/invoices",
        {
          method: mode === "edit" ? "PUT" : "POST",
          body: JSON.stringify(body),
        },
      );
      toast.success(
        mode === "edit"
          ? "Document mis à jour"
          : documentType === "QUOTE"
            ? "Devis créé"
            : "Facture créée",
      );
      onSuccess(doc);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const isQuote = documentType === "QUOTE";
  const eur = (n: number) => euros(n);
  const catalog = catalogGroups(services);
  const clientGroups = [{ heading: "", options: clients.map((c) => ({ value: c.id, label: c.displayName, meta: c.clientNumber ?? undefined })) }];
  const needsClient = clients.find((c) => c.id === form.clientId);
  const clientNeeds = needsClient?.serviceNeeds ?? [];
  const openNeeds = pendingNeeds(clientNeeds);
  const doneNeeds = clientNeeds.length - openNeeds.length;
  const visibleNeeds = showDoneNeeds ? clientNeeds : openNeeds;
  const needsDetails = needsClient?.needsDetails?.trim() ?? "";
  const quoted = new Set(form.lines.map((l) => l.serviceId).filter(Boolean));

  // Paiement (E2) : échéances, abonnements et moyens, tels que l'API les appliquera à l'émission.
  const scheduleBaseCents = Math.round((mixedQuote ? oneOffPreview : totalPreview) * 100);
  const showSchedule = isQuote && !subscriptionOnly;
  const plans = planSettings ? plansShown(form.paymentPlanOffer, scheduleBaseCents, planSettings) : [];
  const subLines = form.lines.flatMap((line, index) => (line.isSubscription && !line.isOptional ? [{ line, index }] : []));
  const lineName = (line: DocLine) => services.find((x) => x.id === line.serviceId)?.name ?? (line.description.split(/ : |\n/)[0]?.trim() || "Abonnement");
  const periodCents = (line: DocLine) => eurosInputToCents(line.unitPriceEuros);
  const cardMax = planSettings ? formatEUR(planSettings.paymentCardMaxCents) : "";
  const oneOffMeansText = planSettings
    ? orList([
        ...oneOffMeans(0, planSettings).filter((m) => m !== "carte bancaire"),
        ...(planSettings.paymentCardEnabled ? [`carte bancaire (jusqu'à ${cardMax} par paiement)`] : []),
      ])
    : "";
  // Devis avec mode : écart entre échéances et montant par période (toutes lignes).
  const intervalDays = planSettings?.installmentIntervalDays ?? 30;
  const recurringPeriodCents = subLines.reduce((sum, { line }) => sum + eurosInputToCents(line.unitPriceEuros), 0);

  // Clavier rapide (D2) : Entrée dans la quantité ou le prix passe à la désignation de la ligne suivante, et sur la
  // dernière ligne en ajoute une. Entrée dans la désignation reste un retour à la ligne.
  // Ligne du catalogue (texte statique) : le focus va au premier champ modifiable de la ligne.
  const linesRef = useRef<HTMLUListElement>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  useEffect(() => {
    if (focusLine === null) return;
    linesRef.current
      ?.querySelector<HTMLElement>(`[data-line="${focusLine}"] :is(textarea, input:not([disabled]))`)
      ?.focus();
    setFocusLine(null);
  }, [focusLine, form.lines.length]);
  /** Texte d'une ligne venue du catalogue, inchangé : affiché en titre et description, sans zone de saisie. */
  const catalogText = (line: DocLine) => {
    if (!line.serviceId || line.editText) return null;
    const svc = services.find((x) => x.id === line.serviceId);
    if (!svc) return null;
    const text = svc.description ? `${svc.name} : ${svc.description}` : svc.name;
    if (line.description === text) return { title: svc.name, description: svc.description };
    // Pack d'un devis avec mode : « Nom : contenu », texte produit par l'API (pack-lines).
    if (svc.isPack && line.description.startsWith(`${svc.name} : `)) return { title: svc.name, description: line.description.slice(svc.name.length + 3) };
    return null;
  };
  const onLineKeyDown = (index: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (index === form.lines.length - 1) addLine();
    setFocusLine(index + 1);
  };
  /** Désignation : hauteur qui suit le texte (une ligne au départ, six au plus), sans étirer les autres champs. */
  const descriptionRows = (text: string) => Math.min(6, Math.max(1, text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 60)), 0)));
  const recapRef = useRef<HTMLElement>(null);

  const sectionTitle = "font-display text-base font-semibold text-[var(--text)]";
  const lineLabel = "mb-1 block text-xs font-medium text-[var(--muted)] lg:sr-only";
  const totalsLine = "flex items-baseline justify-between gap-3 text-sm";
  const blockTitle = "text-sm font-semibold text-[var(--text)]";

  return (
    <>
    <form onSubmit={onSubmit}>
    {/* Grille dans un bloc à part : la barre d'actions reste enfant direct du formulaire, donc collante. */}
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:items-start lg:gap-8">
    <div className="min-w-0 space-y-8">
      {/* Client et dates */}
      <section className="space-y-3" aria-labelledby="doc-client">
        <h3 id="doc-client" className={sectionTitle}>
          Client et dates
        </h3>
        <Combobox
          label="Client"
          groups={clientGroups}
          value={form.clientId}
          disabled={clients.length === 0}
          placeholder={clients.length === 0 ? "Aucun client : créez-en un d'abord" : "Choisir un client"}
          searchPlaceholder="Nom ou numéro de client"
          emptyText="Aucun client ne correspond."
          onChange={(clientId) => setForm((f) => ({ ...f, clientId, sourceQuoteId: "" }))}
        />
        {isQuote ? (
          <p className="text-sm text-[var(--muted)]">
            <span className="font-medium text-[var(--text)]">Validité : 30 jours</span>, calculée automatiquement à partir de la
            date d&apos;émission. Le client peut l&apos;accepter en ligne depuis son espace.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-12">
            <Field
              className="sm:col-span-8"
              label="Devis lié (facultatif)"
              hint={
                signedQuotes.length === 0
                  ? "Aucun devis signé pour ce client : la facture reste indépendante."
                  : "Rattache la facture à un devis signé : il apparaît dans les documents liés, et le paiement démarre le projet."
              }
            >
              <Select
                value={form.sourceQuoteId}
                disabled={signedQuotes.length === 0}
                onChange={(e) => setForm((f) => ({ ...f, sourceQuoteId: e.target.value }))}
              >
                <option value="">Aucun (facture indépendante)</option>
                {signedQuotes.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.number} · {eur(q.totalCents / 100)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field className="sm:col-span-4" label="Date de la prestation" hint="Si elle diffère de la date d'émission.">
              <DateInput value={form.serviceDate} onChange={(v) => setForm((f) => ({ ...f, serviceDate: v }))} />
            </Field>
            {form.sourceQuoteId ? (
              <div className="sm:col-span-12">
                <Button type="button" variant="secondary" onClick={() => void copyQuoteLines(form.sourceQuoteId)}>
                  Reprendre ses prestations
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* Mode avant les prestations : il fixe le prix des lignes (achat ou annuel) et ce que le catalogue propose. */}
      {isQuote ? (
        <section className="space-y-3" aria-labelledby="doc-mode">
          <h3 id="doc-mode" className={sectionTitle}>
            {proposals ? "Propositions et mode de facturation" : "Mode de facturation"}
          </h3>
          {proposals ? (
            <div className="space-y-3" data-proposals>
              <Segmented
                label="Proposition affichée"
                value={PROPOSAL_LETTERS[proposals.active]}
                options={PROPOSAL_LETTERS.map((id) => ({ id, label: `Proposition ${id}` }))}
                onChange={(id) => switchProposal(id === "A" ? 0 : 1)}
              />
              <div className="flex flex-wrap items-end gap-2">
                <Field className="min-w-0 flex-[1_1_16rem]" label={`Nom de la proposition ${PROPOSAL_LETTERS[proposals.active]}`} hint="Vu par le client, ex. « Annuel avec engagement 3 ans ».">
                  <Input
                    maxLength={120}
                    value={proposals.labels[proposals.active]}
                    onChange={(e) =>
                      setProposals({
                        ...proposals,
                        labels: proposals.active === 0 ? [e.target.value, proposals.labels[1]] : [proposals.labels[0], e.target.value],
                      })
                    }
                  />
                </Field>
                <Button type="button" variant="ghost" onClick={() => setRemovingProposal(true)}>
                  <FontAwesomeIcon icon={faTrashCan} aria-hidden />
                  Retirer la proposition {PROPOSAL_LETTERS[proposals.active]}
                </Button>
              </div>
              <p className="text-sm text-[var(--muted)]">
                Le client choisit l'une des deux à la signature. Client et notes sont communs ; mode, prestations, paiement et
                remise sont propres à chaque proposition ; seules les prestations de la proposition retenue sont facturées.
              </p>
            </div>
          ) : null}
          <BillingModeChoice value={form.billingMode} onChange={(next) => void switchBillingMode(next)} />
          <ScopePreview mode={quoteMode} clientId={form.clientId} serviceIds={scopeServiceIds} />
          {proposals ? null : (
            <Button type="button" variant="secondary" onClick={addProposal}>
              <FontAwesomeIcon icon={faPlus} aria-hidden />
              Ajouter une 2e proposition
            </Button>
          )}
        </section>
      ) : null}

      {documentType === "QUOTE" && (clientNeeds.length > 0 || needsDetails) ? (
        <details className="rounded-[var(--radius)] border border-[var(--border)] p-3" data-quote-needs>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
            Besoins du client ({openNeeds.length} à traiter)
          </summary>
          {visibleNeeds.length > 0 ? (
            <ul className="mt-2 space-y-1" aria-label="Besoins du client">
              {visibleNeeds.map((need) => {
                const inCatalog = services.some((s) => s.id === need.serviceId);
                return (
                  <li key={need.serviceId} className="flex min-w-0 items-center justify-between gap-2">
                    <span className={`min-w-0 break-words text-sm ${need.doneAt ? "text-[var(--muted)] line-through" : ""}`}>
                      {need.name}
                      {need.doneAt ? <span className="sr-only"> (traité)</span> : null}
                    </span>
                    {quoted.has(need.serviceId) ? (
                      <span className="shrink-0 text-xs text-[var(--muted)]">Dans le devis</span>
                    ) : inCatalog ? (
                      <Button
                        variant="ghost"
                        className="shrink-0 text-sm"
                        aria-label={`Ajouter au devis : ${need.name}`}
                        onClick={() => addFromCatalog(need.serviceId)}
                      >
                        Ajouter au devis
                      </Button>
                    ) : (
                      <span className="shrink-0 text-xs text-[var(--muted)]">Prestation archivée</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {needsDetails ? (
            <div className="mt-2 space-y-1 text-sm">
              <p className="font-medium">Précisions</p>
              <p className="whitespace-pre-line break-words text-[var(--muted)]">{needsDetails}</p>
            </div>
          ) : null}
          {doneNeeds > 0 ? (
            <button
              type="button"
              className="link mt-2 min-h-11 text-sm"
              aria-expanded={showDoneNeeds}
              onClick={() => setShowDoneNeeds((v) => !v)}
            >
              {showDoneNeeds ? "Masquer les besoins traités" : `Afficher les besoins traités (${doneNeeds})`}
            </button>
          ) : null}
        </details>
      ) : null}

      {/* Prestations : tableau dès 1024 px (en-têtes de colonnes), cartes avec libellés au téléphone. */}
      <section className="space-y-3" aria-labelledby="doc-lines">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="doc-lines" className={sectionTitle}>
            Prestations
          </h3>
          <div className="flex flex-wrap gap-2">
            {services.length > 0 ? (
              <Combobox
                variant="action"
                label="Catalogue des prestations"
                placeholder="Ajouter depuis le catalogue"
                searchPlaceholder="Prestation, pack ou abonnement"
                emptyText="Aucune prestation ne correspond."
                groups={catalog}
                onChange={addFromCatalog}
              />
            ) : null}
          </div>
        </div>

        <div
          aria-hidden
          className="hidden border-b border-[var(--border)] pb-2 text-xs font-medium text-[var(--muted)] lg:grid lg:grid-cols-[minmax(0,1fr)_5.5rem_8rem_7rem_2.75rem] lg:gap-2"
        >
          <span>Désignation</span>
          <span>Qté</span>
          <span>{quoteMode === "RECURRING" ? "Prix (annuel si abonnement)" : "Prix unitaire"}</span>
          <span className="text-right">Total</span>
          <span />
        </div>
        <ul ref={linesRef} className="space-y-2 lg:space-y-0">
          {form.lines.map((line, i) => {
            const lineTotal = (line.isSubscription ? 1 : Number(line.quantity) || 0) * (Number(line.unitPriceEuros) || 0);
            const outOfTotal = documentType === "QUOTE" && (!billedWithDocument(line) || Boolean(line.isOptional));
            const monthly = line.isSubscription && quoteMode !== "RECURRING" ? monthlyEquivalentText(eurosInputToCents(line.unitPriceEuros), line.billingInterval) : null;
            const fixed = catalogText(line);
            return (
              <li
                key={i}
                data-line={i}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3 lg:rounded-none lg:border-0 lg:border-b lg:bg-transparent lg:px-0 lg:py-2"
              >
                {line.groupTitle ? (
                  <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                    {line.isPackDiscount ? "Remise du pack" : "Pack"} : {line.groupTitle}
                  </p>
                ) : null}
                {line.isOptional ? (
                  <p className="mb-2">
                    <Badge tone="amber">Option (au choix du client)</Badge>
                  </p>
                ) : null}
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_2.75rem] items-end gap-2 lg:grid-cols-[minmax(0,1fr)_5.5rem_8rem_7rem_2.75rem] lg:items-start">
                  {fixed ? (
                    <div className="col-span-3 min-w-0 lg:col-span-1">
                      <span className={lineLabel} aria-hidden>
                        Désignation
                      </span>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 py-2">
                          <p className="break-words text-sm font-medium text-[var(--text)]">
                            <span className="sr-only">Ligne {i + 1} : </span>
                            {fixed.title}
                          </p>
                          {fixed.description ? (
                            <p className="mt-0.5 whitespace-pre-line break-words text-xs text-[var(--muted)]">{fixed.description}</p>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          className="h-[var(--field-h)] min-w-11 shrink-0 px-0"
                          aria-label={`Modifier le texte de la ligne ${i + 1}`}
                          title="Modifier le texte"
                          onClick={() => {
                            updateLine(i, { editText: true });
                            setFocusLine(i);
                          }}
                        >
                          <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>
                  ) : (
                  <label className="col-span-3 min-w-0 lg:col-span-1">
                    <span className={lineLabel}>Désignation</span>
                    <Textarea
                      required
                      rows={descriptionRows(line.description)}
                      className="min-h-[var(--field-h)] resize-none py-2.5"
                      aria-label={`Ligne ${i + 1} : désignation`}
                      placeholder="Désignation de la prestation"
                      value={line.description}
                      onChange={(e) => updateLine(i, { description: e.target.value })}
                    />
                  </label>
                  )}
                  <label className="min-w-0">
                    <span className={lineLabel}>Qté</span>
                    <Input
                      required
                      aria-label={`Ligne ${i + 1} : quantité`}
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      value={line.isSubscription ? "1" : line.quantity}
                      disabled={line.isSubscription}
                      onKeyDown={onLineKeyDown(i)}
                      onChange={(e) => updateLine(i, { quantity: e.target.value })}
                    />
                  </label>
                  {quoteMode === "RECURRING" && line.isSubscription ? (
                    // Récurrent : le prix saisi est annuel ; la période (total de la ligne) en découle.
                    <label className="min-w-0">
                      <span className={lineLabel}>Prix annuel</span>
                      <Input
                        required
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        aria-label={`Ligne ${i + 1} : prix annuel en euros`}
                        placeholder="€ / an"
                        value={line.annualEuros ?? ""}
                        onKeyDown={onLineKeyDown(i)}
                        onChange={(e) =>
                          updateLine(i, { annualEuros: e.target.value, unitPriceEuros: periodEuros(e.target.value, form.recurring.interval) })
                        }
                      />
                    </label>
                  ) : (
                  <label className="min-w-0">
                    <span className={lineLabel}>{line.isOptional ? "Prix annuel" : line.isSubscription ? `Prix ${periodSuffix(line.billingInterval)}` : "Prix unitaire"}</span>
                    <Input
                      required
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      aria-label={`Ligne ${i + 1} : prix unitaire en euros`}
                      placeholder={line.isSubscription ? `€ ${periodSuffix(line.billingInterval)}` : "€"}
                      value={line.unitPriceEuros}
                      onKeyDown={onLineKeyDown(i)}
                      onChange={(e) => updateLine(i, { unitPriceEuros: e.target.value })}
                    />
                  </label>
                  )}
                  <p className="col-span-2 flex h-[var(--field-h)] items-center text-sm tabular-nums lg:col-span-1 lg:justify-end">
                    <span className="mr-1 text-xs text-[var(--muted)] lg:sr-only">Total de la ligne :</span>
                    {outOfTotal ? <span className="text-xs text-[var(--muted)]">Hors total</span> : <span className="font-medium">{eur(lineTotal)}</span>}
                  </p>
                  <Button
                    variant="danger-ghost"
                    className="h-[var(--field-h)] min-w-11 px-0"
                    aria-label={`Supprimer la ligne ${i + 1}`}
                    disabled={form.lines.length <= 1}
                    onClick={() => removeLine(i)}
                  >
                    <FontAwesomeIcon icon={faTrashCan} className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                {line.isOptional ? (
                  <div className="mt-1.5 space-y-1 text-xs text-[var(--muted)]">
                    <label className="flex flex-wrap items-center gap-2">
                      Engagement
                      <Select
                        className="w-auto"
                        aria-label={`Ligne ${i + 1} : durée d'engagement de l'option`}
                        value={line.commitmentMonths || "12"}
                        onChange={(e) => updateLine(i, { commitmentMonths: e.target.value })}
                      >
                        {COMMITMENTS.map((m) => (
                          <option key={m} value={m}>
                            {m} mois
                          </option>
                        ))}
                      </Select>
                      à partir de la livraison
                    </label>
                    <p>Abonnement annuel proposé en option : le client le retient ou non à la signature. Il démarre à la livraison.</p>
                  </div>
                ) : line.isSubscription && quoteMode === "RECURRING" ? (
                  <p className="mt-1.5 text-xs text-[var(--muted)]">
                    Soit {formatEUR(eurosInputToCents(line.unitPriceEuros))} par {PERIOD_WORD[form.recurring.interval]} ; période, engagement et départ dans
                    la section Paiement.
                  </p>
                ) : line.isSubscription ? (
                  <p className="mt-1.5 text-xs text-[var(--muted)]">
                    Abonnement {line.billingInterval === "YEAR" ? "annuel" : "mensuel"} :{" "}
                    {isQuote ? "période, départ et engagement" : "période et jour de facturation"} dans la section Paiement.
                  </p>
                ) : quoteMode === "RECURRING" && line.description.trim() ? (
                  <p className="mt-1.5 text-xs text-[var(--danger)]">
                    Pas de ligne ponctuelle en paiement récurrent : le prix annuel comprend toute la prestation. Retirez cette ligne.
                  </p>
                ) : null}
                {outOfTotal && !line.isOptional ? (
                  <p className="mt-1.5 text-xs text-[var(--muted)]">Hors total du devis : 1re facture repoussée (date précise ou mois offerts).</p>
                ) : null}
                {monthly ? <p className="mt-1 text-xs text-[var(--muted)]">{monthly}</p> : null}
              </li>
            );
          })}
        </ul>
        {/* Récurrent : seulement des abonnements du catalogue (une ligne libre serait ponctuelle, refusée). */}
        {quoteMode === "RECURRING" ? null : (
          <Button variant="secondary" onClick={() => {
            addLine();
            setFocusLine(form.lines.length);
          }}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Ligne libre
          </Button>
        )}
      </section>

      {/* Paiement */}
      <section className="space-y-6" aria-labelledby="doc-terms">
        <h3 id="doc-terms" className={sectionTitle}>
          Paiement
        </h3>
        {quoteMode === "ONE_OFF" && planSettings ? (
          <OneOffSchedule
            offer={form.paymentPlanOffer}
            onOffer={(paymentPlanOffer) => setForm((f) => ({ ...f, paymentPlanOffer: paymentPlanOffer as DocumentFormValues["paymentPlanOffer"] }))}
            totalCents={Math.round(totalPreview * 100)}
            intervalDays={intervalDays}
            split3MinTotalCents={planSettings.split3MinTotalCents}
          />
        ) : quoteMode === "RECURRING" ? (
          <RecurringSettings value={form.recurring} onChange={setRecurring} periodCents={recurringPeriodCents} promos={promos} />
        ) : (
        <>
        {subscriptionOnly ? (
          <p className="text-sm text-[var(--muted)]">
            <span className="font-medium text-[var(--text)]">Abonnement, sans acompte.</span> Après la signature, le client met en
            place le prélèvement (ou reçoit sa 1re facture sans Stripe) ; chaque échéance est ensuite facturée par
            l&apos;abonnement.
          </p>
        ) : null}

        {showSchedule ? (
          <div className="space-y-3">
            <h4 className={blockTitle}>{mixedQuote ? "Partie ponctuelle" : "Échéancier"}</h4>
            <Field
              className="max-w-xl"
              label="Formule de paiement"
              hint={
                mixedQuote
                  ? `Acompte et échéancier sur la partie ponctuelle (${formatEUR(Math.round(oneOffPreview * 100))}) ; l'abonnement démarre à la livraison.${
                      planSettings && form.paymentPlanOffer !== "TWO" && oneOffPreview * 100 < planSettings.split3MinTotalCents
                        ? ` Sous ${formatEUR(planSettings.split3MinTotalCents)}, le devis passera en 2 fois à l'émission.`
                        : ""
                    }`
                  : planSettings && form.paymentPlanOffer !== "TWO" && totalPreview * 100 < planSettings.split3MinTotalCents
                    ? `Sous ${formatEUR(planSettings.split3MinTotalCents)}, le devis passera en 2 fois à l'émission.`
                    : form.paymentPlanOffer === "CHOICE"
                      ? "Le client choisira à la signature ; les deux échéanciers figurent sur le devis."
                      : undefined
              }
            >
              <Select
                value={form.paymentPlanOffer}
                onChange={(e) => setForm((f) => ({ ...f, paymentPlanOffer: e.target.value as DocumentFormValues["paymentPlanOffer"] }))}
              >
                <option value="TWO">En 2 fois : acompte et solde</option>
                <option value="THREE">En 3 fois : acompte, 2e acompte à une étape, solde</option>
                <option value="CHOICE">Au choix du client (2 ou 3 fois)</option>
              </Select>
            </Field>
            {planSettings && scheduleBaseCents > 0 ? (
              <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
                {plans.map((plan) => (
                  <dl key={plan} className="space-y-1 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
                    <dt className="font-medium">{plan === "THREE" ? "En 3 fois" : "En 2 fois"}</dt>
                    {installments(plan, scheduleBaseCents, planSettings).map((m) => (
                      <dd key={m.label} className="flex items-baseline justify-between gap-3">
                        <span className="text-[var(--muted)]">
                          {m.label} ({m.percentBps / 100} %)
                        </span>
                        <span className="tabular-nums">{formatEUR(m.amountCents)}</span>
                      </dd>
                    ))}
                  </dl>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {subLines.length > 0 ? (
          <div className="space-y-3">
            <h4 className={blockTitle}>{subLines.length > 1 ? "Abonnements" : "Abonnement"}</h4>
            {subLines.map(({ line, index }) => (
              <fieldset key={index} className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
                <legend className="px-1 font-medium">
                  {lineName(line)} <span className="font-normal text-[var(--muted)]">(ligne {index + 1})</span>
                </legend>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--muted)]" aria-hidden>
                    Période
                  </span>
                  <Segmented
                    label={`Ligne ${index + 1} : périodicité de l'abonnement`}
                    options={INTERVAL_OPTIONS}
                    value={line.billingInterval}
                    onChange={(next) => changeLineInterval(index, next)}
                  />
                  <span className="tabular-nums">
                    {formatEUR(periodCents(line))} {periodSuffix(line.billingInterval)}
                  </span>
                </div>
                {subscriptionOnly || mixedQuote ? (
                  <SubscriptionStartFields index={index} line={line} hasProject={mixedQuote} onChange={(patch) => updateLine(index, patch)} />
                ) : (
                  <label className="flex flex-wrap items-center gap-2 text-[var(--muted)]">
                    Facturée le
                    <Select
                      className="w-auto"
                      aria-label={`Ligne ${index + 1} : jour de facturation`}
                      value={line.billingDay}
                      onChange={(e) => updateLine(index, { billingDay: e.target.value })}
                    >
                      {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                        <option key={d} value={String(d)}>
                          {d}
                        </option>
                      ))}
                    </Select>
                    {line.billingInterval === "YEAR"
                      ? "du mois, chaque année à la date anniversaire (1re année incluse dans ce document)"
                      : "de chaque mois (1re échéance incluse dans ce document)"}
                  </label>
                )}
              </fieldset>
            ))}
          </div>
        ) : null}

        </>
        )}

        {planSettings ? (
          <div className="space-y-1.5">
            <h4 className={blockTitle}>Moyens de paiement</h4>
            <ul className="space-y-1 text-sm text-[var(--muted)]">
              {quoteMode === "RECURRING" ? (
                <>
                  <li>
                    <span className="text-[var(--text)]">Abonnement :</span> {orList(subscriptionMeans(recurringPeriodCents, planSettings))}, chaque{" "}
                    {form.recurring.interval === "YEAR" ? "année" : form.recurring.interval === "QUARTER" ? "trimestre" : "mois"}.
                  </li>
                </>
              ) : null}
              {quoteMode !== "RECURRING" && !subscriptionOnly ? (
                <li>
                  <span className="text-[var(--text)]">{subLines.length ? "Partie ponctuelle" : isQuote ? "Échéances" : "Facture"} :</span> {oneOffMeansText}.
                  Le virement sur l&apos;IBAN de la facture reste possible.
                </li>
              ) : null}
              {(quoteMode === "RECURRING" ? [] : subLines).map(({ line, index }) => (
                <li key={index}>
                  <span className="text-[var(--text)]">{lineName(line)} :</span> {orList(subscriptionMeans(periodCents(line), planSettings))}, chaque{" "}
                  {line.billingInterval === "YEAR" ? "année" : "mois"}.
                </li>
              ))}
            </ul>
            <a href="/settings?tab=payments" target="_blank" rel="noopener" className="link inline-flex min-h-11 items-center text-sm">
              Modifier les moyens dans les réglages (nouvel onglet)
            </a>
          </div>
        ) : null}

        <Field label={isQuote ? "Conditions de règlement" : "Conditions de paiement"}>
          <Textarea autoGrow value={form.paymentTerms} onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
        </Field>
      </section>

      {/* Notes et bon de commande */}
      <details className="group border-t border-[var(--border)] pt-2" open={Boolean(form.notes || form.purchaseOrderRef)}>
        <summary className={`flex min-h-11 cursor-pointer items-center gap-2 ${sectionTitle}`}>
          <FontAwesomeIcon icon={faChevronRight} className="h-3 w-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
          Notes et bon de commande
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-12">
          <Field className="sm:col-span-5" label="Bon de commande du client" hint="Sa référence, s'il en a fourni un.">
            <Input value={form.purchaseOrderRef} onChange={(e) => setForm((f) => ({ ...f, purchaseOrderRef: e.target.value }))} />
          </Field>
          <Field className="sm:col-span-12" label="Notes" hint="Affichées sur le PDF.">
            <Textarea value={form.notes} rows={3} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
        </div>
      </details>
    </div>

    {/* Récapitulatif : à droite dès 1024 px (collant), en fin de formulaire au téléphone. */}
    <aside
      ref={recapRef}
      aria-labelledby="doc-recap"
      className="mt-8 space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-4 lg:sticky lg:top-0 lg:mt-0"
    >
      <h3 id="doc-recap" className={sectionTitle}>
        Récapitulatif
      </h3>
      {quoteMode === "RECURRING" ? null : (
      <>
      <p className={totalsLine}>
        <span className="text-[var(--muted)]">{mixedQuote ? "Partie ponctuelle" : "Sous-total"}</span>
        <span className="tabular-nums">{eur(mixedQuote ? oneOffSubtotal : subtotalPreview)}</span>
      </p>
      <div className="space-y-2">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <Field label="Remise">
            <Select
              value={form.discountType}
              onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value as DocumentFormValues["discountType"] }))}
            >
              <option value="NONE">Aucune</option>
              <option value="PERCENT">En %</option>
              <option value="FIXED">En €</option>
            </Select>
          </Field>
          {form.discountType === "PERCENT" ? (
            <Field label="Pourcentage">
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="10"
                value={form.discountPercent}
                onChange={(e) => setForm((f) => ({ ...f, discountPercent: e.target.value }))}
              />
            </Field>
          ) : form.discountType === "FIXED" ? (
            <Field label="Montant (€)">
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="50.00"
                value={form.discountEuros}
                onChange={(e) => setForm((f) => ({ ...f, discountEuros: e.target.value }))}
              />
            </Field>
          ) : null}
        </div>
        {discountPreview > 0 ? (
          <p className={totalsLine}>
            <span className="text-[var(--muted)]">Remise</span>
            <span className="tabular-nums">−{eur(discountPreview)}</span>
          </p>
        ) : null}
        {form.discountType !== "NONE" && mixedQuote ? (
          <p className="text-xs text-[var(--muted)]">Sur la partie ponctuelle seulement : l&apos;abonnement reste à son prix.</p>
        ) : null}
      </div>
      </>
      )}
      <div className="border-t border-[var(--border)] pt-3">
        {quoteMode === "RECURRING" ? (
          <RecurringRecap value={form.recurring} periodCents={recurringPeriodCents} promos={promos} />
        ) : (
        <>
        <p className={totalsLine}>
          <span className="font-semibold">{mixedQuote ? "Total du projet" : optionalLines.length ? "Total sans option" : "Total"}</span>
          <span className="font-display text-2xl font-semibold tabular-nums">{eur(mixedQuote ? oneOffPreview : totalPreview)}</span>
        </p>
        {optionalLines.length ? (
          <p className={`${totalsLine} mt-1`}>
            <span className="text-[var(--muted)]">Avec option</span>
            <span className="tabular-nums">
              {eur(totalPreview)} + {formatEUR(optionalYearCents)} par an
            </span>
          </p>
        ) : null}
        </>
        )}
        {planSettings?.vatMention ? <p className="mt-1 text-xs text-[var(--muted)]">{planSettings.vatMention}</p> : null}
      </div>
      {quoteMode === "ONE_OFF" && planSettings && totalPreview > 0 ? (
        <div className="space-y-1 border-t border-[var(--border)] pt-3">
          {(() => {
            const shown = modePlansShown(form.paymentPlanOffer, Math.round(totalPreview * 100), planSettings);
            return (
              <>
                <p className="text-sm font-medium">Échéances{shown.length > 1 ? " (au choix du client)" : ""}</p>
                {shown.map((plan) => (
                  <p key={plan} className="text-xs text-[var(--muted)]">
                    {plan === "ONE" ? "Comptant" : plan === "THREE" ? "En 3 fois" : "En 2 fois"} :{" "}
                    <span className="tabular-nums text-[var(--text)]">
                      {equalInstallments(plan, Math.round(totalPreview * 100), intervalDays)
                        .map((m) => formatEUR(m.amountCents))
                        .join(" + ")}
                    </span>
                  </p>
                ))}
              </>
            );
          })()}
        </div>
      ) : null}
      {!quoteMode && showSchedule && planSettings && scheduleBaseCents > 0 ? (
        <div className="space-y-1 border-t border-[var(--border)] pt-3">
          <p className="text-sm font-medium">Échéances{plans.length > 1 ? " (au choix du client)" : ""}</p>
          {plans.map((plan) => (
            <p key={plan} className="text-xs text-[var(--muted)]">
              {plan === "THREE" ? "En 3 fois" : "En 2 fois"} :{" "}
              <span className="tabular-nums text-[var(--text)]">
                {installments(plan, scheduleBaseCents, planSettings)
                  .map((m) => formatEUR(m.amountCents))
                  .join(" + ")}
              </span>
            </p>
          ))}
        </div>
      ) : null}
      {subLines.length > 0 && quoteMode !== "RECURRING" ? (
        <div className="space-y-2 border-t border-[var(--border)] pt-3">
          {subLines.map(({ line, index }) => {
            const months = Number(line.commitmentMonths) || 0;
            return (
              <div key={index} className="space-y-0.5">
                <p className={totalsLine}>
                  <span className="min-w-0 break-words text-[var(--muted)]">{lineName(line)}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatEUR(periodCents(line))} {periodSuffix(line.billingInterval)}
                  </span>
                </p>
                {isQuote ? (
                  <p className="text-xs text-[var(--muted)]">
                    {months
                      ? `Engagement ${months} mois, soit ${formatEUR(commitmentTotalCents(periodCents(line), line.billingInterval, months))} sur la durée`
                      : "Sans engagement"}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {widePreview ? (
        <div className="space-y-2 border-t border-[var(--border)] pt-3">
          <p className="text-sm font-medium">Aperçu</p>
          <DocumentPreview body={previewBody} pausedReason={previewPaused} active kindLabel={previewKind} />
        </div>
      ) : (
        <Button variant="secondary" className="w-full" onClick={() => setPreviewOpen(true)}>
          Aperçu du PDF
        </Button>
      )}
    </aside>
    </div>

      <ModalActions>
        {/* Téléphone : le total renvoie au récapitulatif ; Annuler reste dans la croix de la fenêtre et sous Échap. */}
        <button
          type="button"
          className="mr-auto flex min-h-11 flex-col items-start justify-center text-left"
          onClick={() => recapRef.current?.scrollIntoView({ block: "start" })}
        >
          <span className="text-xs text-[var(--muted)]">
            {quoteMode === "RECURRING" ? `Par ${PERIOD_WORD[form.recurring.interval]}` : mixedQuote ? "Total du projet" : optionalLines.length ? "Total sans option" : "Total"}
            <span className="lg:hidden"> (détail)</span>
          </span>
          <span className="font-display text-lg font-semibold tabular-nums">
            {quoteMode === "RECURRING" ? formatEUR(recurringPeriodCents) : eur(mixedQuote ? oneOffPreview : totalPreview)}
          </span>
        </button>
        <Button variant="secondary" className="max-sm:hidden" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy || !form.clientId}>
          {busy ? "Enregistrement…" : mode === "edit" ? "Enregistrer" : isQuote ? "Créer le devis" : "Créer la facture"}
        </Button>
      </ModalActions>
    </form>
    <Modal
      open={previewOpen && !widePreview}
      onClose={() => setPreviewOpen(false)}
      title={`Aperçu ${documentType === "QUOTE" ? "du devis" : "de la facture"}`}
      description="Le document tel qu'il sera émis. Rien n'est enregistré."
      fullScreenMobile
    >
      <DocumentPreview body={previewBody} pausedReason={previewPaused} active={previewOpen && !widePreview} kindLabel={previewKind} />
    </Modal>
    <ConfirmDialog
      open={removingProposal}
      title={`Retirer la proposition ${proposals ? PROPOSAL_LETTERS[proposals.active] : ""}`}
      message="Ses prestations, son mode et sa remise sont retirés du devis. L’autre proposition reste, seule."
      confirmLabel="Retirer"
      danger
      onConfirm={removeProposal}
      onClose={() => setRemovingProposal(false)}
    />
    </>
  );
}

export type { Client };

/**
 * Ligne d'abonnement d'un devis : départ de la facturation (signature, livraison, date précise, mois offerts) et jour de
 * prélèvement, avec la phrase qui figurera sur le devis, le PDF et l'espace client.
 */
function SubscriptionStartFields({
  index,
  line,
  hasProject,
  onChange,
}: {
  index: number;
  line: DocLine;
  hasProject: boolean;
  onChange: (patch: Partial<DocLine>) => void;
}) {
  const start = startOf(line);
  const n = index + 1;
  const phrase = startPhrase(start, hasProject, Math.round((Number(line.unitPriceEuros) || 0) * 100), line.billingInterval);
  const control =
    "min-h-11 rounded-[var(--radius-sm)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-2 text-sm text-[var(--text)]";
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
          Facturation à partir de
          <Select
            className="w-auto"
            aria-label={`Ligne ${n} : facturation à partir de`}
            value={start.subscriptionStart}
            onChange={(e) => onChange({ subscriptionStart: e.target.value as SubscriptionStart })}
          >
            {startOptions(hasProject).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        {start.subscriptionStart === "DATE" ? (
          <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
            le
            <DateInput
              required
              min={todayIso()}
              aria-label={`Ligne ${n} : date de la 1re facture`}
              value={start.subscriptionStartDate}
              onChange={(v) => onChange({ subscriptionStartDate: v })}
            />
          </label>
        ) : null}
        {start.subscriptionStart === "FREE_MONTHS" ? (
          <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
            <input
              type="number"
              required
              min={1}
              max={FREE_MONTHS_MAX}
              inputMode="numeric"
              className={`${control} w-20`}
              aria-label={`Ligne ${n} : nombre de mois offerts`}
              value={start.subscriptionFreeMonths}
              onChange={(e) => onChange({ subscriptionFreeMonths: e.target.value })}
            />
            mois offerts à partir {hasProject ? "de la livraison du projet" : "de la signature"}
          </label>
        ) : null}
        <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
          prélevé le
          <Select
            className="w-auto"
            aria-label={`Ligne ${n} : jour de prélèvement`}
            value={line.billingDay}
            onChange={(e) => onChange({ billingDay: e.target.value })}
          >
            {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
          </Select>
          {line.billingInterval === "YEAR" ? "du mois anniversaire" : "de chaque mois"}
        </label>
        <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
          engagement
          <Select
            className="w-auto"
            aria-label={`Ligne ${n} : durée d'engagement`}
            value={line.commitmentMonths ?? ""}
            onChange={(e) => onChange({ commitmentMonths: e.target.value })}
          >
            <option value="">sans engagement</option>
            <option value="12">12 mois</option>
            <option value="24">24 mois</option>
            <option value="36">36 mois</option>
          </Select>
        </label>
      </div>
      <p className="text-[var(--muted)]" aria-live="polite">
        {phrase ? `Sur le devis : « ${phrase} », sans acompte.` : "Complétez la date ou le nombre de mois offerts."}
        {start.subscriptionStart === "DATE"
          ? " 1re facture au premier jour de prélèvement à partir de cette date."
          : start.subscriptionStart === "FREE_MONTHS"
            ? " 1re facture au premier jour de prélèvement après les mois offerts."
            : ""}
      </p>
    </div>
  );
}

/**
 * Compris et non compris imprimés sous la formule (28/10/2026), en lecture seule : liste de l'offre du site (module Site)
 * en abonnement, clause « Paiement unique : ce qui n'est pas compris » (Réglages) en paiement unique.
 */
function ScopePreview({ mode, clientId, serviceIds }: { mode: "" | BillingMode; clientId: string; serviceIds: string }) {
  const [scope, setScope] = useState<{ included: string[]; excluded: string[] } | null>(null);
  useEffect(() => {
    if (!mode) {
      setScope(null);
      return;
    }
    let alive = true;
    const q = new URLSearchParams({ mode, serviceIds });
    if (clientId && !isLocalClientId(clientId)) q.set("clientId", clientId);
    api<{ included: string[]; excluded: string[] } | null>(`/api/invoices/scope-preview?${q.toString()}`)
      .then((r) => alive && setScope(r))
      .catch(() => alive && setScope(null));
    return () => {
      alive = false;
    };
  }, [mode, clientId, serviceIds]);
  const included = mode === "RECURRING";
  const items = (included ? scope?.included : scope?.excluded) ?? [];
  if (!items.length) return null;
  return (
    <details className="rounded-[var(--radius)] border border-[var(--border)] p-3" data-quote-scope>
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
        {included ? "Compris dans l'abonnement" : "Non compris"} : ce que le devis indiquera
      </summary>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-[var(--muted)]">
        {included
          ? "Texte de l'offre du site, modifiable dans le module Site."
          : "Texte de la clause « Paiement unique : ce qui n'est pas compris », modifiable dans Réglages, mentions légales."}
      </p>
    </details>
  );
}
