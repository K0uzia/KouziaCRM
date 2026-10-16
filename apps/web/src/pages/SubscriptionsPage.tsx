import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlus,
  faPlay,
  faPause,
  faStop,
  faPen,
  faSync,
  faTrash,
  faEnvelope,
  faArrowUpRightFromSquare,
} from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR, formatDate } from "@/lib/api";
import { useFeatures } from "@/lib/features";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, PageHeader, Badge } from "@/components/ui/Card";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";
import { useCreateParam } from "@/lib/use-create-param";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatStrip } from "@/components/ui/StatStrip";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Segmented";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import {
  INTERVAL_OPTIONS,
  monthlyEquivalentCents,
  normalizeInterval,
  periodAdjective,
  periodSuffix,
  suggestedAmountCents,
  type BillingInterval,
} from "@/lib/billing-interval";

type SubscriptionStatus = "ACTIVE" | "PAUSED" | "ENDED";

type Subscription = {
  id: string;
  label: string;
  amountCents: number;
  billingDay: number;
  billingInterval?: string | null;
  startDate: string;
  endDate: string | null;
  status: SubscriptionStatus;
  nextInvoiceAt: string;
  /** Dernière facture émise par l'abonnement : null tant que la 1re échéance n'est pas passée. */
  lastInvoiceId?: string | null;
  collectionMethod?: string | null;
  stripeSubscriptionId?: string | null;
  /** État brut Stripe (past_due, unpaid…) et résiliation programmée dans Stripe. */
  stripeStatus?: string | null;
  stripeCancelAt?: string | null;
  /** Demande de résiliation faite par le client dans /suivi (abonnement par virement). */
  cancellationRequestedAt?: string | null;
  client: { id: string; displayName: string; clientNumber: string | null };
  service: { id: string; name: string };
};

type Client = { id: string; displayName: string };
type Service = {
  id: string;
  name: string;
  description?: string | null;
  unitPriceCents: number;
  isSubscription?: boolean;
  defaultBillingDay?: number;
  active?: boolean;
  stripeProductId?: string | null;
  billingInterval?: string | null;
};

const emptyOfferForm = {
  name: "",
  description: "",
  unitPriceEuros: "",
  defaultBillingDay: "1",
  active: true,
};

const statusBadge: Record<SubscriptionStatus, { tone: "green" | "amber" | "neutral"; label: string }> = {
  ACTIVE: { tone: "green", label: "Actif" },
  PAUSED: { tone: "amber", label: "Suspendu" },
  ENDED: { tone: "neutral", label: "Clôturé" },
};

const emptyForm = {
  clientId: "",
  serviceId: "",
  label: "",
  amountEuros: "",
  billingDay: "1",
  billingInterval: "MONTH" as BillingInterval,
  startDate: new Date().toISOString().slice(0, 10),
  /** Vide : 1re facture au prochain jour de prélèvement. Rempli : 1re échéance différée (ex. une année offerte). */
  firstInvoiceAt: "",
  collectionMethod: "MANUAL_TRANSFER" as "MANUAL_TRANSFER" | "STRIPE",
};

/** Avenant envoyé avant les abonnements multiples, accepté, à rattacher à l'un des abonnements du client. */
type RevisionToAttach = {
  lineId: string;
  quoteId: string;
  quoteNumber: string | null;
  displayName: string;
  description: string;
  amountCents: number;
  billingInterval: BillingInterval;
  subscriptions: Array<{ id: string; label: string; amountCents: number; billingInterval: BillingInterval }>;
};

/** Montant proposé (en euros, saisie) pour une offre et une périodicité. */
function suggestEuros(svc: Service, interval: BillingInterval, freeMonths: number): string {
  return (suggestedAmountCents(svc.unitPriceCents, svc.billingInterval, interval, freeMonths) / 100).toFixed(2);
}

/** Libellé par défaut d'une offre : « Nom : mensuel » ou « Nom : annuel ». */
function defaultLabel(svc: Service, interval: BillingInterval): string {
  return `${svc.name} : ${periodAdjective(interval)}`;
}

function SubscriptionBadges({ s, stripeEnabled }: { s: Subscription; stripeEnabled: boolean }) {
  const badge = statusBadge[s.status];
  const stripeActive = s.status !== "ENDED" && s.collectionMethod === "STRIPE" && !!s.stripeSubscriptionId;
  const stripePending = stripeEnabled && s.status !== "ENDED" && !s.stripeSubscriptionId;
  const unpaid = s.status === "PAUSED" && s.stripeStatus === "unpaid";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap">
      <Badge tone={unpaid ? "red" : badge.tone}>{unpaid ? "Suspendu, impayé" : badge.label}</Badge>
      {s.status === "ACTIVE" && s.stripeStatus === "past_due" ? <Badge tone="amber">En retard</Badge> : null}
      {s.status !== "ENDED" && s.stripeCancelAt ? (
        <Badge tone="neutral" className="whitespace-normal">
          Résiliation programmée le {formatDate(s.stripeCancelAt)}
        </Badge>
      ) : null}
      {s.status !== "ENDED" && s.cancellationRequestedAt ? (
        <Badge tone="amber" className="whitespace-normal">
          Résiliation demandée le {formatDate(s.cancellationRequestedAt)}
        </Badge>
      ) : null}
      {stripeActive ? (
        <Badge tone="green">Stripe actif</Badge>
      ) : stripePending ? (
        <Badge tone="amber">Lien à envoyer</Badge>
      ) : null}
    </span>
  );
}

function stripeProductUrl(productId: string): string {
  return `https://dashboard.stripe.com/products/${productId}`;
}

export function SubscriptionsPage() {
  const {
    moduleSubscriptionsEnabled,
    moduleStripeEnabled,
    loading: featuresLoading,
  } = useFeatures();
  const [rows, setRows] = useState<Subscription[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [offers, setOffers] = useState<Service[]>([]);
  const [offerOpen, setOfferOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<Service | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerForm, setOfferForm] = useState(emptyOfferForm);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseId, setReviseId] = useState<string | null>(null);
  const [reviseAmount, setReviseAmount] = useState("");
  const [reviseLabel, setReviseLabel] = useState("");
  const [reviseInterval, setReviseInterval] = useState<BillingInterval>("MONTH");
  const [reviseBusy, setReviseBusy] = useState(false);
  const [freeMonths, setFreeMonths] = useState(2);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const [subs, cls, svcs, catalog, settings] = await Promise.all([
      api<Subscription[]>("/api/subscriptions"),
      api<Client[]>("/api/clients").catch(() => [] as Client[]),
      api<Service[]>("/api/services?active=1&subscription=1").catch(() => [] as Service[]),
      api<Service[]>("/api/services?subscription=1").catch(() => [] as Service[]),
      api<{ annualFreeMonths?: number }>("/api/settings").catch(() => null),
    ]);
    setRows(subs);
    setClients(cls);
    setServices(svcs);
    setOffers(catalog);
    if (typeof settings?.annualFreeMonths === "number") setFreeMonths(settings.annualFreeMonths);
    setLoaded(true);
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  function openCreateOffer() {
    setEditingOffer(null);
    setOfferForm(emptyOfferForm);
    setOfferOpen(true);
  }

  function openEditOffer(s: Service) {
    setEditingOffer(s);
    setOfferForm({
      name: s.name,
      description: s.description ?? "",
      unitPriceEuros: (s.unitPriceCents / 100).toFixed(2),
      defaultBillingDay: String(s.defaultBillingDay ?? 1),
      active: s.active !== false,
    });
    setOfferOpen(true);
  }

  async function onOfferSubmit(e: FormEvent) {
    e.preventDefault();
    setOfferBusy(true);
    try {
      const body = {
        name: offerForm.name,
        description: offerForm.description || null,
        unitPriceEuros: Number(offerForm.unitPriceEuros),
        unit: "FORFAIT" as const,
        active: offerForm.active,
        isSubscription: true,
        defaultBillingDay: Number(offerForm.defaultBillingDay) || 1,
      };
      if (editingOffer) {
        await api(`/api/services/${editingOffer.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        toast.success("Offre abonnement mise à jour");
      } else {
        await api("/api/services", { method: "POST", body: JSON.stringify(body) });
        toast.success("Offre abonnement créée");
      }
      setOfferOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setOfferBusy(false);
    }
  }

  function openCreate() {
    setEditingId(null);
    // Offre présélectionnée : son prix, son libellé et son jour de prélèvement aussi.
    const svc = services[0];
    const interval = normalizeInterval(svc?.billingInterval);
    setForm({
      ...emptyForm,
      clientId: clients[0]?.id ?? "",
      serviceId: svc?.id ?? "",
      billingInterval: interval,
      amountEuros: svc ? suggestEuros(svc, interval, freeMonths) : "",
      label: svc ? defaultLabel(svc, interval) : "",
      billingDay: svc?.defaultBillingDay ? String(svc.defaultBillingDay) : emptyForm.billingDay,
    });
    setOpen(true);
  }

  /** Montant saisi à la main (différent du montant proposé) : on ne l'écrase pas. */
  function amountTyped(svc: Service | undefined, interval: BillingInterval): boolean {
    return form.amountEuros !== "" && (!svc || form.amountEuros !== suggestEuros(svc, interval, freeMonths));
  }

  function changeInterval(next: BillingInterval) {
    const svc = services.find((x) => x.id === form.serviceId);
    const typed = amountTyped(svc, form.billingInterval);
    setForm({
      ...form,
      billingInterval: next,
      amountEuros: svc && !typed ? suggestEuros(svc, next, freeMonths) : form.amountEuros,
      label: svc && form.label === defaultLabel(svc, form.billingInterval) ? defaultLabel(svc, next) : form.label,
    });
  }

  // Arrivée par « Créer > Nouvel abonnement » : on attend les offres pour préremplir le formulaire.
  const [params, setParams] = useSearchParams();
  const attachLine = params.get("rattacher");
  const [toAttach, setToAttach] = useState<RevisionToAttach | null>(null);
  const [attachTarget, setAttachTarget] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  useEffect(() => {
    if (!attachLine) return;
    let cancelled = false;
    api<RevisionToAttach[]>("/api/subscriptions/revisions-to-attach")
      .then((list) => {
        if (cancelled) return;
        const found = list.find((x) => x.lineId === attachLine) ?? null;
        if (!found) toast.info("Cet avenant est déjà rattaché.");
        setToAttach(found);
        setAttachTarget(found?.subscriptions[0]?.id ?? "");
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Avenants indisponibles"));
    return () => {
      cancelled = true;
    };
  }, [attachLine]);
  function closeAttach() {
    setToAttach(null);
    const next = new URLSearchParams(params);
    next.delete("rattacher");
    setParams(next, { replace: true });
  }
  async function confirmAttach(e: FormEvent) {
    e.preventDefault();
    if (!toAttach || !attachTarget) return;
    setAttachBusy(true);
    try {
      await api(`/api/subscriptions/${attachTarget}/attach-line`, { method: "POST", body: JSON.stringify({ lineId: toAttach.lineId }) });
      toast.success("Avenant rattaché : l'abonnement est mis à jour");
      closeAttach();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rattachement impossible");
    } finally {
      setAttachBusy(false);
    }
  }

  const [createRequested, setCreateRequested] = useState(false);
  useCreateParam(() => setCreateRequested(true));
  useEffect(() => {
    if (!createRequested || !loaded) return;
    setCreateRequested(false);
    openCreate();
  }, [createRequested, loaded]);

  const [offerToArchive, setOfferToArchive] = useState<Service | null>(null);

  async function archiveOffer(o: Service) {
    try {
      const res = await api<{ archived: boolean }>(`/api/services/${o.id}`, { method: "DELETE" });
      toast.success(res.archived ? "Offre archivée (utilisée par des contrats ou documents)" : "Offre supprimée");
      setOfferToArchive(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  function openEdit(s: Subscription) {
    setEditingId(s.id);
    setForm({
      clientId: s.client.id,
      serviceId: s.service.id,
      label: s.label,
      amountEuros: (s.amountCents / 100).toString(),
      billingDay: String(s.billingDay),
      billingInterval: normalizeInterval(s.billingInterval),
      startDate: s.startDate.slice(0, 10),
      firstInvoiceAt: s.nextInvoiceAt.slice(0, 10),
      collectionMethod: s.collectionMethod === "STRIPE" ? "STRIPE" : "MANUAL_TRANSFER",
    });
    setOpen(true);
  }

  /** Date de 1re facture encore modifiable : rien de facturé ni de prélèvement Stripe relié. */
  const editing = rows.find((r) => r.id === editingId) ?? null;
  const firstInvoiceEditable = !editing || (!editing.lastInvoiceId && !editing.stripeSubscriptionId);

  const revising = rows.find((r) => r.id === reviseId) ?? null;

  function openRevise(s: Subscription) {
    setReviseId(s.id);
    setReviseAmount((s.amountCents / 100).toString());
    setReviseLabel(s.label);
    setReviseInterval(normalizeInterval(s.billingInterval));
    setReviseOpen(true);
  }

  function changeReviseInterval(next: BillingInterval) {
    if (!revising) return;
    const cents = suggestedAmountCents(revising.amountCents, revising.billingInterval, next, freeMonths);
    setReviseInterval(next);
    setReviseAmount((cents / 100).toFixed(2));
    const suffix = `: ${periodAdjective(reviseInterval)}`;
    if (reviseLabel.endsWith(suffix)) {
      setReviseLabel(`${reviseLabel.slice(0, -suffix.length)}: ${periodAdjective(next)}`);
    }
  }

  async function onReviseSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reviseId) return;
    setReviseBusy(true);
    try {
      const res = await api<{ quoteNumber: string | null; emailed: boolean }>(
        `/api/subscriptions/${reviseId}/revise`,
        {
          method: "POST",
          body: JSON.stringify({
            amountEuros: Number(reviseAmount),
            label: reviseLabel.trim() || undefined,
            billingInterval: reviseInterval,
          }),
        },
      );
      toast.success(
        `Devis ${res.quoteNumber ?? ""} émis au client${res.emailed ? " (PDF envoyé)" : ""}. Abonnement mis à jour à l'acceptation.`,
      );
      setReviseOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setReviseBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        clientId: form.clientId,
        serviceId: form.serviceId,
        label: form.label,
        amountEuros: Number(form.amountEuros),
        billingDay: Number(form.billingDay),
        billingInterval: form.billingInterval,
        startDate: form.startDate,
        firstInvoiceAt: form.firstInvoiceAt || null,
        collectionMethod: form.collectionMethod,
      };
      if (editingId) {
        const firstInvoiceChanged =
          firstInvoiceEditable && form.firstInvoiceAt && editing && form.firstInvoiceAt !== editing.nextInvoiceAt.slice(0, 10);
        await api(`/api/subscriptions/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            label: payload.label,
            billingDay: payload.billingDay,
            ...(firstInvoiceChanged ? { firstInvoiceAt: form.firstInvoiceAt } : {}),
          }),
        });
        toast.success("Abonnement modifié");
      } else {
        await api("/api/subscriptions", { method: "POST", body: JSON.stringify(payload) });
        toast.success("Abonnement créé");
      }
      setOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, kind: "pause" | "resume" | "end") {
    const viaStripe = Boolean(rows.find((r) => r.id === id)?.stripeSubscriptionId);
    try {
      await api(`/api/subscriptions/${id}/${kind}`, { method: "POST" });
      const done =
        kind === "pause" ? "Abonnement suspendu" : kind === "resume" ? "Abonnement repris" : "Abonnement clôturé";
      const stripeDone =
        kind === "pause" ? "prélèvement Stripe suspendu" : kind === "resume" ? "prélèvement Stripe repris" : "prélèvement Stripe résilié";
      toast.success(viaStripe ? `${done} (${stripeDone})` : done);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    }
  }

  async function resendStripeSetup(id: string) {
    try {
      await api(`/api/subscriptions/${id}/resend-setup`, { method: "POST", body: "{}" });
      toast.success("Lien de prélèvement renvoyé au client");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Envoi impossible");
    }
  }

  const [tab, setTab] = useTabParam(["contrats", "offres"] as const, "contrats");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [endTarget, setEndTarget] = useState<Subscription | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  /** Ferme le panneau du contrat avant d'ouvrir une autre fenêtre. */
  function fromPanel(fn: () => void) {
    setSelectedId(null);
    fn();
  }

  const contractColumns: DataColumn<Subscription>[] = [
    {
      name: "Client",
      grow: 2,
      selector: (s) => s.client.displayName,
      sortable: true,
      cell: (s) => (
        // Bouton dans la 1re colonne : ouverture du panneau au clavier.
        <span className="min-w-0 py-1">
          <button
            type="button"
            onClick={() => setSelectedId(s.id)}
            className="block min-h-11 max-w-full whitespace-normal text-left font-medium text-[var(--text)] hover:text-[var(--primary)]"
          >
            {s.client.displayName}
          </button>
          <span className="block whitespace-normal text-xs text-[var(--muted)]">{s.service.name}</span>
        </span>
      ),
    },
    {
      name: "Libellé",
      grow: 2,
      selector: (s) => s.label,
      cell: (s) => <span className="py-2 whitespace-normal">{s.label}</span>,
    },
    {
      name: "Montant",
      width: "9rem",
      right: true,
      selector: (s) => monthlyEquivalentCents(s.amountCents, s.billingInterval),
      sortable: true,
      cell: (s) => (
        <span className="whitespace-nowrap tabular-nums">
          <span className="font-medium">{formatEUR(s.amountCents)}</span>{" "}
          <span className="text-[var(--muted)]">{periodSuffix(s.billingInterval)}</span>
        </span>
      ),
    },
    {
      name: "Échéance",
      width: "10rem",
      showFrom: 1200,
      selector: (s) => s.nextInvoiceAt,
      sortable: true,
      cell: (s) => <span className="whitespace-nowrap text-[var(--muted)]">{formatDate(s.nextInvoiceAt)}</span>,
    },
    {
      name: "Statut",
      width: "12rem",
      selector: (s) => s.status,
      cell: (s) => <SubscriptionBadges s={s} stripeEnabled={moduleStripeEnabled} />,
    },
  ];

  if (!featuresLoading && !moduleSubscriptionsEnabled) {
    return <Navigate to="/services" replace />;
  }

  return (
    <div>
      <PageHeader
        title="Abonnements"
        subtitle="Contrats de maintenance mensuels ou annuels : chaque échéance est facturée automatiquement."
        actions={
          <>
            {!moduleStripeEnabled ? (
              <Button variant="secondary" onClick={openCreateOffer}>
                <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
                Nouvelle offre
              </Button>
            ) : null}
            <Button onClick={openCreate}>
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
              Nouvel abonnement
            </Button>
          </>
        }
      />

      {rows.length > 0 ? (
        <StatStrip
          className="mb-6"
          items={(() => {
            const active = rows.filter((r) => r.status === "ACTIVE");
            const next = active
              .map((r) => r.nextInvoiceAt)
              .filter(Boolean)
              .sort()[0];
            return [
              {
                label: "Revenu mensuel récurrent",
                shortLabel: "Revenu mensuel",
                value: formatEUR(
                  active.reduce((acc, r) => acc + monthlyEquivalentCents(r.amountCents, r.billingInterval), 0),
                ),
                hint: active.some((r) => normalizeInterval(r.billingInterval) === "YEAR")
                  ? "Contrats actifs, annuels ramenés au mois"
                  : "Contrats actifs",
                tone: "success" as const,
              },
              { label: "Contrats actifs", value: String(active.length) },
              { label: "Suspendus", value: String(rows.filter((r) => r.status === "PAUSED").length) },
              { label: "Prochaine facture", value: next ? formatDate(next) : "-" },
            ];
          })()}
        />
      ) : null}

      <Tabs
        label="Abonnements"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "contrats", label: "Contrats clients", count: rows.length },
          { id: "offres", label: "Offres", count: offers.filter((o) => o.active).length },
        ]}
      >
        {tab === "contrats" ? (
            <DataTable
              columns={contractColumns}
              data={rows}
              searchable={["client.displayName", "label", "service.name"]}
              searchPlaceholder="Rechercher un contrat…"
              countLabel={rows.length > 1 ? "contrats" : "contrat"}
              emptyTitle="Aucun abonnement"
              emptyHint="Créez un contrat de maintenance mensuel ou annuel : chaque échéance sera facturée automatiquement."
              onRowClick={(s) => setSelectedId(s.id)}
              renderMobileCard={(s) => (
                // Carte entière = bouton : ouvre le panneau du contrat et ses actions.
                <button
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  className="flex w-full min-w-0 flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 text-left"
                >
                  <span className="flex w-full min-w-0 items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block font-semibold text-[var(--text)]">{s.client.displayName}</span>
                      <span className="block text-sm text-[var(--muted)]">{s.label}</span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-right tabular-nums">
                      <span className="block font-medium">{formatEUR(s.amountCents)}</span>
                      <span className="block text-xs text-[var(--muted)]">{periodSuffix(s.billingInterval)}</span>
                    </span>
                  </span>
                  <span className="flex w-full flex-wrap items-center justify-between gap-2 text-sm text-[var(--muted)]">
                    <span>Prochaine facture : {formatDate(s.nextInvoiceAt)}</span>
                    <SubscriptionBadges s={s} stripeEnabled={moduleStripeEnabled} />
                  </span>
                </button>
              )}
            />
        ) : (
            <Card className="overflow-hidden">
              {offers.length === 0 ? (
                <EmptyState
                  title="Aucune offre abonnement"
                  hint="Définissez vos forfaits mensuels (maintenance, hébergement, etc.) avant de créer un contrat."
                />
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {offers
                    .filter((o) => o.active)
                    .map((o) => (
                      <li
                        key={o.id}
                        className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-[var(--surface-raised)] sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{o.name}</p>
                          {o.description ? <p className="mt-1 text-sm text-[var(--muted)]">{o.description}</p> : null}
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            {normalizeInterval(o.billingInterval) === "YEAR"
                              ? "Facturée chaque année"
                              : `Facturée le ${o.defaultBillingDay ?? 1} de chaque mois`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
                          <div className="sm:text-right">
                            <p className="font-display text-lg font-semibold tabular-nums">{formatEUR(o.unitPriceCents)}</p>
                            <p className="text-xs text-[var(--muted)]">{periodSuffix(o.billingInterval)}</p>
                          </div>
                          <div className="flex gap-1">
                            {moduleStripeEnabled && o.stripeProductId ? (
                              <a
                                href={stripeProductUrl(o.stripeProductId)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-h-11 items-center gap-1.5 px-2 text-sm text-[var(--primary)] hover:underline"
                              >
                                Modifier dans Stripe
                                <FontAwesomeIcon
                                  icon={faArrowUpRightFromSquare}
                                  className="h-3 w-3"
                                  aria-hidden
                                />
                              </a>
                            ) : null}
                            {!moduleStripeEnabled ? (
                              <>
                                <Button
                                  variant="ghost"
                                  className="px-0"
                                  aria-label={`Modifier ${o.name}`}
                                  title="Modifier"
                                  onClick={() => openEditOffer(o)}
                                >
                                  <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                                <Button
                                  variant="danger-ghost"
                                  className="px-0"
                                  aria-label={`Archiver ${o.name}`}
                                  title="Archiver"
                                  onClick={() => setOfferToArchive(o)}
                                >
                                  <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </Card>

        )}
      </Tabs>

      <ConfirmDialog
        open={Boolean(offerToArchive)}
        title="Retirer cette offre"
        message={`« ${offerToArchive?.name ?? ""} » ne sera plus proposée. Les contrats en cours ne changent pas ; si l'offre est déjà utilisée, elle est archivée.`}
        confirmLabel="Retirer"
        danger
        onConfirm={() => offerToArchive && void archiveOffer(offerToArchive)}
        onClose={() => setOfferToArchive(null)}
      />

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelectedId(null)}
        title={selected ? selected.client.displayName : "Contrat"}
        description={selected ? selected.label : undefined}
      >
        {selected ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-[var(--muted)]">Montant</dt>
                <dd className="mt-0.5 font-medium tabular-nums">
                  {formatEUR(selected.amountCents)} {periodSuffix(selected.billingInterval)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-[var(--muted)]">Prochaine facture</dt>
                <dd className="mt-0.5">{formatDate(selected.nextInvoiceAt)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-[var(--muted)]">Offre</dt>
                <dd className="mt-0.5">{selected.service.name}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-[var(--muted)]">Jour de prélèvement</dt>
                <dd className="mt-0.5">Le {selected.billingDay}</dd>
              </div>
              <div className="col-span-2 min-w-0">
                <dt className="text-xs text-[var(--muted)]">Statut</dt>
                <dd className="mt-1">
                  <SubscriptionBadges s={selected} stripeEnabled={moduleStripeEnabled} />
                </dd>
              </div>
            </dl>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {selected.status !== "ENDED" ? (
                <Button variant="secondary" onClick={() => fromPanel(() => openEdit(selected))}>
                  <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
                  Modifier
                </Button>
              ) : null}
              {selected.status === "ACTIVE" ? (
                <Button variant="secondary" onClick={() => fromPanel(() => openRevise(selected))}>
                  <FontAwesomeIcon icon={faSync} className="h-3.5 w-3.5" aria-hidden />
                  Réviser (avenant)
                </Button>
              ) : null}
              {moduleStripeEnabled && selected.status !== "ENDED" && !selected.stripeSubscriptionId ? (
                <Button variant="secondary" onClick={() => void resendStripeSetup(selected.id)}>
                  <FontAwesomeIcon icon={faEnvelope} className="h-3.5 w-3.5" aria-hidden />
                  Renvoyer le lien de prélèvement
                </Button>
              ) : null}
              {selected.status === "ACTIVE" ? (
                <Button variant="secondary" onClick={() => fromPanel(() => void action(selected.id, "pause"))}>
                  <FontAwesomeIcon icon={faPause} className="h-3.5 w-3.5" aria-hidden />
                  Suspendre
                </Button>
              ) : null}
              {selected.status === "PAUSED" ? (
                <Button variant="secondary" onClick={() => fromPanel(() => void action(selected.id, "resume"))}>
                  <FontAwesomeIcon icon={faPlay} className="h-3.5 w-3.5" aria-hidden />
                  Reprendre
                </Button>
              ) : null}
              {selected.status !== "ENDED" ? (
                <Button variant="danger-ghost" onClick={() => fromPanel(() => setEndTarget(selected))}>
                  <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" aria-hidden />
                  Clôturer
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(endTarget)}
        title="Clôturer cet abonnement"
        message={`« ${endTarget?.label ?? ""} » (${endTarget?.client.displayName ?? ""}) : plus aucune facture ne sera émise${endTarget?.stripeSubscriptionId ? " et le prélèvement Stripe sera résilié" : ""}. Les factures déjà émises ne changent pas.`}
        confirmLabel="Clôturer"
        danger
        onConfirm={() => {
          if (endTarget) void action(endTarget.id, "end");
          setEndTarget(null);
        }}
        onClose={() => setEndTarget(null)}
      />

      <Modal open={toAttach !== null} onClose={closeAttach} title={`Rattacher l'avenant ${toAttach?.quoteNumber ?? ""}`}>
        {toAttach ? (
          <form onSubmit={confirmAttach} className="space-y-4">
            <p className="text-sm text-[var(--muted)]">
              {toAttach.displayName} a accepté « {toAttach.description} » ({formatEUR(toAttach.amountCents)}
              {periodSuffix(toAttach.billingInterval)}). Ce devis date d'avant les abonnements multiples : choisissez l'abonnement qu'il révise.
            </p>
            <Field label="Abonnement révisé">
              <Select value={attachTarget} onChange={(e) => setAttachTarget(e.target.value)}>
                {toAttach.subscriptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} : {formatEUR(s.amountCents)}
                    {periodSuffix(s.billingInterval)}
                  </option>
                ))}
              </Select>
            </Field>
            <ModalActions>
              <Button type="button" variant="secondary" onClick={closeAttach}>
                Annuler
              </Button>
              <Button type="submit" disabled={attachBusy || !attachTarget}>
                {attachBusy ? "…" : "Rattacher"}
              </Button>
            </ModalActions>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editingId ? "Modifier l'abonnement" : "Nouvel abonnement"}
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Client">
            <Select
              required
              value={form.clientId}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              disabled={!!editingId}
            >
              <option value="">-</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Offre abonnement"
            hint={(() => {
              // Le select natif tronque son libellé sur mobile : le détail complet est repris dessous.
              const svc = services.find((s) => s.id === form.serviceId);
              return svc ? `${svc.name}, ${formatEUR(svc.unitPriceCents)} ${periodSuffix(svc.billingInterval)}` : undefined;
            })()}
          >
            <Select
              required
              value={form.serviceId}
              onChange={(e) => {
                const id = e.target.value;
                const svc = services.find((s) => s.id === id);
                // Montant saisi à la main (différent du montant proposé) : conservé.
                const prev = services.find((s) => s.id === form.serviceId);
                const typed = amountTyped(prev, form.billingInterval);
                setForm({
                  ...form,
                  serviceId: id,
                  amountEuros: svc && !typed
                    ? suggestEuros(svc, form.billingInterval, freeMonths)
                    : form.amountEuros,
                  label:
                    !form.label || (prev && form.label === defaultLabel(prev, form.billingInterval))
                      ? svc
                        ? defaultLabel(svc, form.billingInterval)
                        : ""
                      : form.label,
                  billingDay: svc?.defaultBillingDay
                    ? String(svc.defaultBillingDay)
                    : form.billingDay,
                });
              }}
              disabled={!!editingId}
            >
              <option value="">Choisir une offre…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}, {formatEUR(s.unitPriceCents)} {periodSuffix(s.billingInterval)}
                </option>
              ))}
            </Select>
          </Field>
          {editingId ? (
            <Field label="Facturation" hint="Pour passer au mensuel ou à l'annuel, utilisez « Réviser (avenant) » dans le contrat.">
              <Input value={form.billingInterval === "YEAR" ? "Annuelle" : "Mensuelle"} disabled readOnly />
            </Field>
          ) : (
            // Groupe de boutons : hors d'un <label>, qui nommerait le premier bouton.
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-[var(--text)]">Facturation</p>
              <Segmented
                label="Périodicité de facturation"
                options={INTERVAL_OPTIONS}
                value={form.billingInterval}
                onChange={changeInterval}
                className="w-full"
              />
              {form.billingInterval === "YEAR" ? (
                <p className="text-xs text-[var(--muted)]">
                  Montant proposé : 12 mensualités moins {freeMonths} mois offert{freeMonths > 1 ? "s" : ""} (Réglages
                  &gt; Paiements), modifiable.
                </p>
              ) : null}
            </div>
          )}
          <Field label="Libellé de la facture">
            <Input
              required
              placeholder="Maintenance site web : mensuel"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field
              label={form.billingInterval === "YEAR" ? "Montant par an (€)" : "Montant par mois (€)"}
              hint={editingId ? "Via un nouveau devis (légal)" : undefined}
            >
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={form.amountEuros}
                onChange={(e) => setForm({ ...form, amountEuros: e.target.value })}
                disabled={!!editingId}
              />
            </Field>
            <Field label="Jour de prélèvement">
              <Select
                value={form.billingDay}
                onChange={(e) => setForm({ ...form, billingDay: e.target.value })}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date de début">
              <Input
                required
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                disabled={!!editingId}
              />
            </Field>
            {firstInvoiceEditable ? (
              <Field
                label="1re facture (facultatif)"
                hint="Vide : au prochain jour de prélèvement. Pour offrir une période (ex. un an), la date de la 1re facture ; le client est prévenu 30 jours avant."
              >
                <Input
                  type="date"
                  min={form.startDate}
                  value={form.firstInvoiceAt}
                  onChange={(e) => setForm({ ...form, firstInvoiceAt: e.target.value })}
                />
              </Field>
            ) : null}
            {moduleStripeEnabled && !editingId ? (
              <Field label="Encaissement">
                <Select
                  value={form.collectionMethod}
                  onChange={(e) => setForm({ ...form, collectionMethod: e.target.value === "STRIPE" ? "STRIPE" : "MANUAL_TRANSFER" })}
                >
                  <option value="MANUAL_TRANSFER">Virement (facture de l'ERP)</option>
                  <option value="STRIPE">Prélèvement Stripe (carte ou SEPA)</option>
                </Select>
              </Field>
            ) : null}
          </div>
          <p className="text-xs text-[var(--muted)]">
            {editingId
              ? "Édition administrative (libellé, jour de prélèvement). Pour changer le montant ou la périodicité, utilisez « Réviser (avenant) » dans le contrat : il émet un devis d'avenant au client et met à jour l'abonnement à l'acceptation."
              : form.billingInterval === "YEAR"
                ? `Une facture sera émise automatiquement chaque année (numéro légal alloué, snapshot client figé). Avant chaque reconduction, le client reçoit l'information prévue par la loi, avant la date limite pour la refuser.${form.collectionMethod === "STRIPE" ? " Prélèvement Stripe : le client reçoit le lien pour le mettre en place." : ""}`
                : `Une facture sera émise automatiquement chaque mois à cette date (numéro légal alloué, snapshot client figé). Si SMTP est configuré, le PDF sera envoyé au client.${form.collectionMethod === "STRIPE" ? " Prélèvement Stripe : le client reçoit le lien pour le mettre en place." : ""}`}
          </p>
          <ModalActions>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "…" : editingId ? "Enregistrer" : "Créer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal
        open={reviseOpen}
        onClose={() => setReviseOpen(false)}
        title="Réviser le contrat (avenant)"
        description="Un devis de révision est émis et envoyé au client. L'abonnement passe au nouveau montant à l'acceptation, et la facture correspondante est émise."
      >
        <form onSubmit={onReviseSubmit} className="space-y-4">
          {revising?.stripeSubscriptionId ? (
            <p className="text-xs text-[var(--muted)]">
              Prélèvement Stripe actif : la périodicité se change dans Stripe.
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-[var(--text)]">Facturation</p>
              <Segmented
                label="Périodicité de facturation"
                options={INTERVAL_OPTIONS}
                value={reviseInterval}
                onChange={changeReviseInterval}
                className="w-full"
              />
            </div>
          )}
          <Field label={reviseInterval === "YEAR" ? "Nouveau montant par an (€)" : "Nouveau montant par mois (€)"}>
            <Input
              required
              type="number"
              step="0.01"
              min="0.01"
              value={reviseAmount}
              onChange={(e) => setReviseAmount(e.target.value)}
            />
          </Field>
          <Field label="Libellé">
            <Input
              required
              placeholder="Maintenance site web : mensuel"
              value={reviseLabel}
              onChange={(e) => setReviseLabel(e.target.value)}
            />
          </Field>
          <p className="text-xs text-[var(--muted)]">
            {revising && reviseInterval !== normalizeInterval(revising.billingInterval)
              ? `Passage ${reviseInterval === "YEAR" ? "à l'annuel" : "au mensuel"} : il s'applique à la prochaine échéance (${formatDate(revising.nextInvoiceAt)}) si le client accepte le devis avant. La période en cours reste facturée comme prévu.`
              : "Ex. ajout d'un site à gérer : le nouveau montant remplace l'ancien à l'acceptation du devis. La période en cours reste facturée à l'ancien montant ; la suivante l'est au nouveau."}
          </p>
          <ModalActions>
            <Button type="button" variant="secondary" onClick={() => setReviseOpen(false)} disabled={reviseBusy}>
              Annuler
            </Button>
            <Button type="submit" disabled={reviseBusy}>
              {reviseBusy ? "Émission…" : "Émettre le devis au client"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal
        open={offerOpen}
        onClose={() => setOfferOpen(false)}
        title={editingOffer ? "Modifier l'offre abonnement" : "Nouvelle offre abonnement"}
      >
        <form onSubmit={onOfferSubmit} className="space-y-4">
          <Field label="Nom">
            <Input
              required
              value={offerForm.name}
              onChange={(e) => setOfferForm({ ...offerForm, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <Input
              value={offerForm.description}
              onChange={(e) => setOfferForm({ ...offerForm, description: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Prix / mois (€)">
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={offerForm.unitPriceEuros}
                onChange={(e) =>
                  setOfferForm({ ...offerForm, unitPriceEuros: e.target.value })
                }
              />
            </Field>
            <Field label="Jour de facturation">
              <Select
                value={offerForm.defaultBillingDay}
                onChange={(e) =>
                  setOfferForm({ ...offerForm, defaultBillingDay: e.target.value })
                }
              >
                {Array.from({ length: 28 }, (_, d) => d + 1).map((d) => (
                  <option key={d} value={String(d)}>
                    Le {d} de chaque mois
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={offerForm.active}
              onChange={(e) => setOfferForm({ ...offerForm, active: e.target.checked })}
            />
            Active (proposée à la création d'un contrat)
          </label>
          <ModalActions>
            <Button type="button" variant="secondary" onClick={() => setOfferOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={offerBusy}>
              {offerBusy ? "…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>
    </div>
  );
}
