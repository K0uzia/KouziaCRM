import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { subscriptionsTotalText } from "@/lib/quote-totals";
import { euros } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { ModalActions } from "@/components/ui/Modal";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import type { Client } from "@/components/clients/ClientForm";
import type { ClientNeed } from "@/components/clients/NeedsEditor";
import { Segmented } from "@/components/ui/Segmented";
import { billedWithDocument, FREE_MONTHS_MAX, startFromLine, startOptions, startPayload, startPhrase, type StartFields, type SubscriptionStart } from "@/lib/subscription-start";
import {
  INTERVAL_OPTIONS,
  normalizeInterval,
  periodSuffix,
  suggestedAmountCents,
  type BillingInterval,
} from "@/lib/billing-interval";

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
  /** Devis : paiement en 2 fois, en 3 fois ou au choix du client (vide = réglages). */
  paymentPlanOffer: "" | "TWO" | "THREE" | "CHOICE";
};

type PlanSettings = { paymentChoiceDefault: boolean; split3MinTotalCents: number; annualFreeMonths?: number };

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
};

const DEPOSIT_TERMS = "Acompte à la validation du devis, solde à la livraison (voir l'échéancier).";
const SUBSCRIPTION_TERMS = "Abonnement sans acompte : chaque échéance est facturée, par prélèvement ou à réception de la facture.";

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
  clients,
  onSuccess,
  onCancel,
}: {
  mode: "create" | "edit";
  documentType: "INVOICE" | "QUOTE";
  documentId?: string;
  initial?: Partial<DocumentFormValues>;
  clients: Array<{ id: string; displayName: string; clientNumber?: string | null; needs?: ClientNeed[]; billingDay?: number | null }>;
  onSuccess: (doc: { id: string }) => void;
  onCancel: () => void;
}) {
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
  });
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
        }>;
      }>(`/api/invoices/${quoteId}`);
      const lines = (q.lines ?? []).map((l) => ({
        description: l.description,
        quantity: String(l.quantity),
        unitPriceEuros: (l.unitPriceCents / 100).toFixed(2),
        isSubscription: Boolean(l.isSubscription),
        billingDay: String(l.billingDay ?? 1),
        billingInterval: normalizeInterval(l.billingInterval),
        serviceId: l.serviceId ?? "",
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
        serviceId: p.isSubscription ? p.serviceId : "",
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

  function addFromCatalog(serviceId: string) {
    const svc = services.find((x) => x.id === serviceId);
    if (!svc) return;
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

  /** Besoin du client repris en ligne : libellé prérempli, prix à saisir (rien d'automatique). */
  function addNeedLine(label: string) {
    const line: DocLine = { ...emptyLine(), description: label };
    setForm((f) => {
      const emptyIndex = f.lines.findIndex((l) => !l.description.trim() && !l.unitPriceEuros);
      const lines = emptyIndex >= 0 ? f.lines.map((l, i) => (i === emptyIndex ? line : l)) : [...f.lines, line];
      return { ...f, lines };
    });
    toast.success("Ligne ajoutée : saisissez le prix.");
  }

  function removeLine(index: number) {
    setForm((f) => ({
      ...f,
      lines: f.lines.length <= 1 ? f.lines : f.lines.filter((_, i) => i !== index),
    }));
  }

  const subtotalPreview = form.lines.reduce((sum, l) => {
    if (documentType === "QUOTE" && !billedWithDocument(l)) return sum;
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
  const filledLines = form.lines.filter((l) => l.description.trim() || l.serviceId);
  const subscriptionOnly = documentType === "QUOTE" && filledLines.length > 0 && filledLines.every((l) => l.isSubscription);
  // Devis mixte : acompte et échéancier sur la partie ponctuelle ; l'abonnement démarre à la livraison.
  const mixedQuote =
    documentType === "QUOTE" && filledLines.some((l) => l.isSubscription) && filledLines.some((l) => !l.isSubscription);
  // Base de l'acompte : partie ponctuelle, remise entière déduite (comme computeDepositBaseCents).
  const oneOffPreview = Math.max(0, oneOffSubtotal - discountPreview);
  const subscriptionLinesPreview = form.lines.filter((l) => l.isSubscription && (Number(l.unitPriceEuros) || 0) > 0);
  const subscriptionsPreviewText = subscriptionsTotalText({
    yearCents: Math.round(subscriptionLinesPreview.filter((l) => l.billingInterval === "YEAR").reduce((s, l) => s + Number(l.unitPriceEuros) * 100, 0)),
    monthCents: Math.round(subscriptionLinesPreview.filter((l) => l.billingInterval !== "YEAR").reduce((s, l) => s + Number(l.unitPriceEuros) * 100, 0)),
  });
  // Conditions par défaut : suivent la nature du devis tant qu'elles n'ont pas été modifiées.
  useEffect(() => {
    setForm((f) => {
      if (subscriptionOnly && f.paymentTerms === DEPOSIT_TERMS) return { ...f, paymentTerms: SUBSCRIPTION_TERMS };
      if (!subscriptionOnly && f.paymentTerms === SUBSCRIPTION_TERMS) return { ...f, paymentTerms: DEPOSIT_TERMS };
      return f;
    });
  }, [subscriptionOnly]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    for (const l of form.lines) {
      if (l.isSubscription && !l.serviceId) {
        toast.error("Chaque ligne abonnement doit être liée à une prestation");
        return;
      }
    }
    setBusy(true);
    try {
      const body = {
        clientId: form.clientId,
        documentType,
        notes: form.notes || null,
        paymentTerms: form.paymentTerms || null,
        serviceDate: documentType === "INVOICE" ? form.serviceDate || null : null,
        purchaseOrderRef: form.purchaseOrderRef || null,
        ...(documentType === "INVOICE" ? { sourceQuoteId: form.sourceQuoteId || null } : {}),
        ...(documentType === "QUOTE" && form.paymentPlanOffer ? { paymentPlanOffer: form.paymentPlanOffer } : {}),
        discountType: form.discountType,
        discountPercent:
          form.discountType === "PERCENT" ? Number(form.discountPercent) || 0 : undefined,
        discountEuros:
          form.discountType === "FIXED" ? Number(form.discountEuros) || 0 : undefined,
        lines: form.lines.map((l) => ({
          description: l.description,
          quantity: l.isSubscription ? 1 : Number(l.quantity),
          unitPriceEuros: Number(l.unitPriceEuros),
          isSubscription: l.isSubscription,
          billingDay: l.isSubscription ? Number(l.billingDay) || 1 : null,
          billingInterval: l.isSubscription ? l.billingInterval : null,
          serviceId: l.isSubscription ? l.serviceId : null,
          groupTitle: l.groupTitle?.trim() || null,
          isPackDiscount: Boolean(l.isPackDiscount),
          ...(documentType === "QUOTE" && l.isSubscription ? startPayload(startOf(l)) : {}),
        })),
      };
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
  const oneOff = services.filter((sv) => !sv.isSubscription && !sv.isPack);
  const monthly = services.filter((sv) => sv.isSubscription);
  const packs = services.filter((sv) => sv.isPack);
  const sectionTitle = "text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]";
  const clientNeeds = clients.find((c) => c.id === form.clientId)?.needs ?? [];
  const doneNeeds = clientNeeds.filter((n) => n.done).length;
  const visibleNeeds = showDoneNeeds ? clientNeeds : clientNeeds.filter((n) => !n.done);

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* 1. Client */}
      <section className="space-y-2" aria-labelledby="doc-client">
        <h3 id="doc-client" className={sectionTitle}>
          1. Client
        </h3>
        <Select
          required
          aria-label="Client"
          value={form.clientId}
          onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value, sourceQuoteId: "" }))}
        >
          {clients.length === 0 ? (
            <option value="">Aucun client : créez-en un d&apos;abord</option>
          ) : (
            clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
                {c.clientNumber ? ` (${c.clientNumber})` : ""}
              </option>
            ))
          )}
        </Select>
        {!isQuote ? (
          <Field
            label="Devis lié (facultatif)"
            hint={
              signedQuotes.length === 0
                ? "Aucun devis signé pour ce client : la facture reste indépendante."
                : "Rattache la facture à un devis signé : il apparaît dans les documents liés, et le paiement démarre le projet."
            }
          >
            <div className="flex flex-wrap gap-2">
              <Select
                className="min-w-0 flex-1"
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
              {form.sourceQuoteId ? (
                <Button type="button" variant="secondary" onClick={() => void copyQuoteLines(form.sourceQuoteId)}>
                  Reprendre ses prestations
                </Button>
              ) : null}
            </div>
          </Field>
        ) : null}
      </section>

      {documentType === "QUOTE" && clientNeeds.length > 0 ? (
        <details className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
            Besoins du client ({clientNeeds.filter((n) => !n.done).length} à traiter)
          </summary>
          <ul className="mt-2 space-y-1" aria-label="Besoins du client">
            {visibleNeeds.map((need) => (
              <li key={need.id} className="flex min-w-0 items-center justify-between gap-2">
                <span className={`min-w-0 break-words text-sm ${need.done ? "text-[var(--muted)] line-through" : ""}`}>
                  {need.label}
                  {need.done ? <span className="sr-only"> (traité)</span> : null}
                </span>
                <Button
                  variant="ghost"
                  className="shrink-0 text-sm"
                  aria-label={`Ajouter comme ligne : ${need.label}`}
                  onClick={() => addNeedLine(need.label)}
                >
                  Ajouter comme ligne
                </Button>
              </li>
            ))}
          </ul>
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

      {/* 2. Prestations */}
      <section className="space-y-3" aria-labelledby="doc-lines">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 id="doc-lines" className={sectionTitle}>
            2. Prestations
          </h3>
        </div>
        {services.length > 0 ? (
          <Select
            aria-label="Ajouter une prestation du catalogue"
            value=""
            onChange={(e) => {
              if (e.target.value) addFromCatalog(e.target.value);
            }}
          >
            <option value="">+ Ajouter depuis le catalogue…</option>
            {oneOff.length ? (
              <optgroup label="Prestations (prix fixe)">
                {oneOff.map((sv) => (
                  <option key={sv.id} value={sv.id}>
                    {sv.name} : {eur(sv.unitPriceCents / 100)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {packs.length ? (
              <optgroup label="Packs (détail et remise ajoutés)">
                {packs.map((sv) => (
                  <option key={sv.id} value={sv.id}>
                    {sv.name} : {eur(sv.unitPriceCents / 100)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {monthly.length ? (
              <optgroup label="Abonnements">
                {monthly.map((sv) => (
                  <option key={sv.id} value={sv.id}>
                    {sv.name} : {eur(sv.unitPriceCents / 100)} {periodSuffix(sv.billingInterval)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        ) : null}

        <ul className="space-y-2">
          {form.lines.map((line, i) => {
            const lineTotal = (line.isSubscription ? 1 : Number(line.quantity) || 0) * (Number(line.unitPriceEuros) || 0);
            return (
              <li key={i} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
                {line.groupTitle ? (
                  <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                    {line.isPackDiscount ? "Remise du pack" : "Pack"} : {line.groupTitle}
                  </p>
                ) : null}
                {line.isSubscription ? (
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <Segmented
                      label={`Ligne ${i + 1} : périodicité de l'abonnement`}
                      options={INTERVAL_OPTIONS}
                      value={line.billingInterval}
                      onChange={(next) => changeLineInterval(i, next)}
                    />
                    {subscriptionOnly || mixedQuote ? (
                      <SubscriptionStartFields
                        index={i}
                        line={line}
                        hasProject={mixedQuote}
                        onChange={(patch) => updateLine(i, patch)}
                      />
                    ) : (
                    <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
                      Facturée le
                      <select
                        className="rounded-[var(--radius-sm)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-1.5 py-1 text-[var(--text)]"
                        aria-label={`Ligne ${i + 1} : jour de facturation`}
                        value={line.billingDay}
                        onChange={(e) => updateLine(i, { billingDay: e.target.value })}
                      >
                        {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                          <option key={d} value={String(d)}>
                            {d}
                          </option>
                        ))}
                      </select>
                      {line.billingInterval === "YEAR"
                        ? "du mois, chaque année à la date anniversaire (1re année incluse dans ce document)"
                        : "de chaque mois (1re échéance incluse dans ce document)"}
                    </label>
                    )}
                  </div>
                ) : null}
                <div className="grid grid-cols-[4.5rem_1fr_auto] gap-2 sm:grid-cols-[1fr_5rem_8rem_auto]">
                  <Textarea
                    required
                    rows={2}
                    className="col-span-3 min-h-[2.75rem] sm:col-span-1"
                    aria-label={`Ligne ${i + 1} : désignation`}
                    placeholder="Désignation de la prestation"
                    value={line.description}
                    onChange={(e) => updateLine(i, { description: e.target.value })}
                  />
                  <Input
                    required
                    aria-label={`Ligne ${i + 1} : quantité`}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0.01"
                    placeholder="Qté"
                    value={line.isSubscription ? "1" : line.quantity}
                    disabled={line.isSubscription}
                    onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  />
                  <Input
                    required
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    aria-label={`Ligne ${i + 1} : prix unitaire en euros`}
                    placeholder={line.isSubscription ? `€ ${periodSuffix(line.billingInterval)}` : "Prix"}
                    value={line.unitPriceEuros}
                    onChange={(e) => updateLine(i, { unitPriceEuros: e.target.value })}
                  />
                  <Button
                    variant="danger-ghost"
                    className="min-h-11 min-w-11 px-0"
                    aria-label={`Supprimer la ligne ${i + 1}`}
                    disabled={form.lines.length <= 1}
                    onClick={() => removeLine(i)}
                  >
                    ×
                  </Button>
                </div>
                <p className="mt-1.5 text-right text-xs text-[var(--muted)]">
                  {documentType === "QUOTE" && !billedWithDocument(line) ? (
                    "Hors total du devis : 1re facture repoussée (date précise ou mois offerts)"
                  ) : (
                    <>
                      Total ligne : <span className="font-medium tabular-nums text-[var(--text)]">{eur(lineTotal)}</span>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
        <Button variant="ghost" className="px-3 text-sm" onClick={addLine}>
          + Ligne libre
        </Button>

        <details className="rounded-[var(--radius)] border border-[var(--border)] p-3" open={form.discountType !== "NONE"}>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Remise</summary>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[12rem_1fr]">
            <Select
              aria-label="Type de remise globale"
              value={form.discountType}
              onChange={(e) =>
                setForm((f) => ({ ...f, discountType: e.target.value as DocumentFormValues["discountType"] }))
              }
            >
              <option value="NONE">Aucune</option>
              <option value="PERCENT">Pourcentage (%)</option>
              <option value="FIXED">Montant fixe (€)</option>
            </Select>
            {form.discountType === "PERCENT" ? (
              <Input
                aria-label="Remise en pourcentage"
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="Ex. 10"
                value={form.discountPercent}
                onChange={(e) => setForm((f) => ({ ...f, discountPercent: e.target.value }))}
              />
            ) : form.discountType === "FIXED" ? (
              <Input
                aria-label="Remise en euros"
                type="number"
                step="0.01"
                min="0"
                placeholder="Ex. 50.00"
                value={form.discountEuros}
                onChange={(e) => setForm((f) => ({ ...f, discountEuros: e.target.value }))}
              />
            ) : null}
          </div>
        </details>
      </section>

      {/* 3. Conditions */}
      <section className="space-y-3" aria-labelledby="doc-terms">
        <h3 id="doc-terms" className={sectionTitle}>
          3. Conditions
        </h3>
        {isQuote ? (
          <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--muted)]">
            <span className="font-medium text-[var(--text)]">Validité : 30 jours</span>, calculée automatiquement à partir de la
            date d&apos;émission. Le client peut l&apos;accepter en ligne depuis son espace.
          </p>
        ) : null}
        {subscriptionOnly ? (
          <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--muted)]">
            <span className="font-medium text-[var(--text)]">Paiement : abonnement, sans acompte.</span> Après la
            signature, le client met en place le prélèvement (ou reçoit sa 1re facture sans Stripe) ; chaque
            échéance est ensuite facturée par l&apos;abonnement.
          </p>
        ) : isQuote ? (
          <Field
            label="Paiement"
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
              onChange={(e) =>
                setForm((f) => ({ ...f, paymentPlanOffer: e.target.value as DocumentFormValues["paymentPlanOffer"] }))
              }
            >
              <option value="TWO">En 2 fois : acompte et solde</option>
              <option value="THREE">En 3 fois : acompte, 2e acompte à une étape, solde</option>
              <option value="CHOICE">Au choix du client (2 ou 3 fois)</option>
            </Select>
          </Field>
        ) : null}
        <div className={isQuote ? "" : "grid gap-4 sm:grid-cols-2"}>
          <Field label={isQuote ? "Conditions de règlement" : "Conditions de paiement"}>
            <Input value={form.paymentTerms} onChange={(e) => setForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
          </Field>
          {!isQuote ? (
            <Field label="Date de la prestation" hint="Si elle diffère de la date d'émission.">
              <Input
                type="date"
                value={form.serviceDate}
                onChange={(e) => setForm((f) => ({ ...f, serviceDate: e.target.value }))}
              />
            </Field>
          ) : null}
        </div>
      </section>

      {/* 4. Compléments */}
      <details className="rounded-[var(--radius)] border border-[var(--border)] p-3" open={Boolean(form.notes || form.purchaseOrderRef)}>
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
          Compléments (bon de commande, notes)
        </summary>
        <div className="mt-3 space-y-4">
          <Field label="Bon de commande du client" hint="Sa référence, s'il en a fourni un.">
            <Input
              value={form.purchaseOrderRef}
              onChange={(e) => setForm((f) => ({ ...f, purchaseOrderRef: e.target.value }))}
            />
          </Field>
          <Field label="Notes" hint="Affichées sur le PDF.">
            <Textarea value={form.notes} rows={3} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
        </div>
      </details>

      <ModalActions>
        <div className="mr-auto basis-full text-sm sm:basis-auto">
          {mixedQuote ? (
            <>
              <span className="text-[var(--muted)]">Total du projet </span>
              <span className="font-display text-lg font-semibold tabular-nums">{eur(oneOffPreview)}</span>
              <span className="block text-xs text-[var(--muted)]">
                Abonnement{subscriptionLinesPreview.length > 1 ? "s" : ""} en plus : {subscriptionsPreviewText}
              </span>
            </>
          ) : (
            <>
              {discountPreview > 0 ? (
                <span className="mr-2 text-xs text-[var(--muted)]">
                  {eur(subtotalPreview)} − {eur(discountPreview)} =
                </span>
              ) : null}
              <span className="text-[var(--muted)]">Total </span>
              <span className="font-display text-lg font-semibold tabular-nums">{eur(totalPreview)}</span>
            </>
          )}
        </div>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy || !form.clientId}>
          {busy ? "Enregistrement…" : mode === "edit" ? "Enregistrer" : isQuote ? "Créer le devis" : "Créer la facture"}
        </Button>
      </ModalActions>
    </form>
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
          <select
            className={control}
            aria-label={`Ligne ${n} : facturation à partir de`}
            value={start.subscriptionStart}
            onChange={(e) => onChange({ subscriptionStart: e.target.value as SubscriptionStart })}
          >
            {startOptions(hasProject).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {start.subscriptionStart === "DATE" ? (
          <label className="flex flex-wrap items-center gap-1.5 text-[var(--muted)]">
            le
            <input
              type="date"
              required
              min={todayIso()}
              className={control}
              aria-label={`Ligne ${n} : date de la 1re facture`}
              value={start.subscriptionStartDate}
              onChange={(e) => onChange({ subscriptionStartDate: e.target.value })}
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
          <select
            className={control}
            aria-label={`Ligne ${n} : jour de prélèvement`}
            value={line.billingDay}
            onChange={(e) => onChange({ billingDay: e.target.value })}
          >
            {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
          </select>
          {line.billingInterval === "YEAR" ? "du mois anniversaire" : "de chaque mois"}
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
