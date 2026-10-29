import { useEffect, useState, type FormEvent } from "react";
import { toIsoDate } from "@/components/ui/DatePicker";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlus,
  faPlay,
  faPause,
  faStop,
  faCalendarXmark,
  faRotateLeft,
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
import { Checkbox, DateInput, Field, Input, Select } from "@/components/ui/Field";
import { useCreateParam } from "@/lib/use-create-param";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatStrip } from "@/components/ui/StatStrip";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Segmented";
import { Combobox } from "@/components/ui/Combobox";
import { catalogOption } from "@/lib/catalog-options";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BuyoutSection } from "@/components/subscriptions/BuyoutSection";
import { LoadState } from "@/pages/site/shared";
import { FilterBar, FilterSegment } from "@/components/ui/ListFilters";
import { useUrlFilters } from "@/lib/use-url-filters";
import {
  eurosInputToCents,
  INTERVAL_OPTIONS,
  monthlyEquivalentCents,
  monthlyEquivalentText,
  normalizeInterval,
  periodAdjective,
  periodSuffix,
  periodWord,
  REVISE_INTERVAL_OPTIONS,
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
  /** Durée et fin d'engagement (offre tout compris) ; null = sans engagement. */
  commitmentMonths?: number | null;
  commitmentEndsAt?: string | null;
  /** « Programmer la fin » : date de fin si elle était programmée maintenant (calculée par l'API). */
  scheduledEndAt?: string | null;
  status: SubscriptionStatus;
  nextInvoiceAt: string;
  /** Dernière facture émise par l'abonnement : null tant que la 1re échéance n'est pas passée. */
  lastInvoiceId?: string | null;
  /** Rien de facturé et 1re échéance à venir (ex. une année offerte) : hors revenu récurrent. */
  firstInvoicePending?: boolean;
  collectionMethod?: string | null;
  stripeSubscriptionId?: string | null;
  /** État brut Stripe (past_due, unpaid…) et résiliation programmée dans Stripe. */
  stripeStatus?: string | null;
  stripeCancelAt?: string | null;
  /** Demande de résiliation faite par le client dans /suivi (abonnement par virement). */
  cancellationRequestedAt?: string | null;
  client: { id: string; displayName: string; clientNumber: string | null };
  service: { id: string; name: string };
  /** Créé à la main, jamais facturé, sans Stripe : supprimable et montant corrigeable (sinon : avenant ou clôture). */
  draftLike?: boolean;
  /** Encore engagé : échéances restant à courir après la période en cours (calculé par l'API). */
  remainingCommitment?: { count: number; amountCents: number; from: string; until: string } | null;
};

type Client = { id: string; displayName: string; billingDay?: number | null };
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
  isPack?: boolean;
  /** Prix annuel du catalogue (abonnement vendu à l'année). */
  annualPriceCents?: number | null;
  /** Offre : prestation ponctuelle de rachat du site (null : pas de rachat). */
  buyoutServiceId?: string | null;
};

const emptyOfferForm = {
  name: "",
  description: "",
  unitPriceEuros: "",
  defaultBillingDay: "1",
  active: true,
  /** Prestation de rachat du site (vide : pas de rachat). */
  buyoutServiceId: "",
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
  // Annuel par défaut : Stripe prélève des frais à chaque transaction (une par an plutôt que douze).
  billingInterval: "YEAR" as BillingInterval,
  startDate: toIsoDate(new Date()),
  /** Vide : 1re facture au prochain jour de prélèvement. Rempli : 1re échéance différée (ex. une année offerte). */
  firstInvoiceAt: "",
  collectionMethod: "MANUAL_TRANSFER" as "MANUAL_TRANSFER" | "STRIPE",
  /** Durée d'engagement en mois ; vide = sans engagement (création seulement). */
  commitmentMonths: "12",
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
/** Dernier jour actif d'une fin programmée : la veille de la fin du terme (l'API pose la fin au dernier instant). */
const lastDayOf = (termEndsAt: string) => formatDate(new Date(new Date(termEndsAt).getTime() - 1).toISOString());

function suggestEuros(svc: Service, interval: BillingInterval, freeMonths: number): string {
  return (suggestedAmountCents(svc.unitPriceCents, svc.billingInterval, interval, freeMonths, svc.annualPriceCents) / 100).toFixed(2);
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
  /** Prestations ponctuelles : choix de la prestation de rachat d'une offre. */
  const [oneOffs, setOneOffs] = useState<Service[]>([]);
  const [offerOpen, setOfferOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<Service | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerForm, setOfferForm] = useState(emptyOfferForm);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Choix obligatoires (client, offre) : la liste de choix n'a pas la validation native d'un <select required>.
  const [missing, setMissing] = useState<{ clientId?: boolean; serviceId?: boolean }>({});
  const [form, setForm] = useState(emptyForm);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseId, setReviseId] = useState<string | null>(null);
  const [reviseAmount, setReviseAmount] = useState("");
  const [reviseLabel, setReviseLabel] = useState("");
  const [reviseInterval, setReviseInterval] = useState<BillingInterval>("MONTH");
  const [reviseBusy, setReviseBusy] = useState(false);
  const [freeMonths, setFreeMonths] = useState(2);
  const [loaded, setLoaded] = useState(false);
  // Échec du chargement : affiché à la place de la liste, avec « Réessayer » (une erreur ne passe plus pour « Aucun contrat »).
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    const [subs, cls, svcs, catalog, settings, ponctuelles] = await Promise.all([
      api<Subscription[]>("/api/subscriptions"),
      api<Client[]>("/api/clients").catch(() => [] as Client[]),
      api<Service[]>("/api/services?active=1&subscription=1").catch(() => [] as Service[]),
      api<Service[]>("/api/services?subscription=1").catch(() => [] as Service[]),
      api<{ annualFreeMonths?: number }>("/api/settings").catch(() => null),
      api<Service[]>("/api/services?subscription=0").catch(() => [] as Service[]),
    ]);
    setOneOffs(ponctuelles.filter((x) => !x.isPack));
    setRows(subs);
    setClients(cls);
    setServices(svcs);
    setOffers(catalog);
    if (typeof settings?.annualFreeMonths === "number") setFreeMonths(settings.annualFreeMonths);
    setLoaded(true);
  }

  function reload() {
    setLoadError(null);
    load().catch((e: Error) => setLoadError(e.message || "Chargement des contrats impossible"));
  }

  useEffect(() => {
    reload();
  }, []);

  function openEditOffer(s: Service) {
    setEditingOffer(s);
    setOfferForm({
      name: s.name,
      description: s.description ?? "",
      unitPriceEuros: (s.unitPriceCents / 100).toFixed(2),
      defaultBillingDay: String(s.defaultBillingDay ?? 1),
      active: s.active !== false,
      buyoutServiceId: s.buyoutServiceId ?? "",
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
        // Nouvelle offre : annuelle (frais Stripe par transaction) ; une offre existante garde sa périodicité.
        ...(editingOffer ? {} : { billingInterval: "YEAR" as const }),
        buyoutServiceId: offerForm.buyoutServiceId || null,
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
    setMissing({});
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
  const [deleteTarget, setDeleteTarget] = useState<Subscription | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function deleteContract(s: Subscription) {
    setDeleteBusy(true);
    try {
      await api(`/api/subscriptions/${s.id}`, { method: "DELETE" });
      toast.success("Contrat supprimé");
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    } finally {
      setDeleteBusy(false);
    }
  }

  // « Archiver » archive toujours (jamais de suppression) : l'offre reste dans « Archivées », Stripe compris.
  async function archiveOffer(o: Service) {
    try {
      await api<{ archived: boolean }>(`/api/services/${o.id}?archive=1`, { method: "DELETE" });
      toast.success("Offre archivée : elle reste visible dans les archives");
      setOfferToArchive(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Archivage impossible");
    }
  }

  /** Offre archivée non liée à Stripe : remise au catalogue (liée : un produit Stripe archivé ne revient pas d'ici). */
  async function restoreOffer(o: Service) {
    try {
      await api(`/api/services/${o.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: o.name,
          description: o.description ?? null,
          unitPriceEuros: o.unitPriceCents / 100,
          unit: "FORFAIT",
          active: true,
          isSubscription: true,
          // Périodicité absente : celle de l'offre est gardée.
          defaultBillingDay: o.defaultBillingDay ?? 1,
        }),
      });
      toast.success("Offre réactivée");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
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
      commitmentMonths: s.commitmentMonths ? String(s.commitmentMonths) : "",
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
    const absent = { clientId: !form.clientId, serviceId: !form.serviceId };
    setMissing(absent);
    if (absent.clientId || absent.serviceId) {
      document.getElementById(absent.clientId ? "subscription-client" : "subscription-offer")?.focus();
      return;
    }
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
        commitmentMonths: form.commitmentMonths ? Number(form.commitmentMonths) : null,
      };
      if (editingId) {
        const firstInvoiceChanged =
          firstInvoiceEditable && form.firstInvoiceAt && editing && form.firstInvoiceAt !== editing.nextInvoiceAt.slice(0, 10);
        const amountChanged = editing?.draftLike && Math.round(Number(form.amountEuros) * 100) !== editing.amountCents;
        await api(`/api/subscriptions/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            label: payload.label,
            billingDay: payload.billingDay,
            ...(firstInvoiceChanged ? { firstInvoiceAt: form.firstInvoiceAt } : {}),
            ...(amountChanged ? { amountEuros: Number(form.amountEuros) } : {}),
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

  async function action(id: string, kind: "pause" | "resume" | "end", opts: { invoiceRemaining?: boolean } = {}) {
    const viaStripe = Boolean(rows.find((r) => r.id === id)?.stripeSubscriptionId);
    try {
      await api(`/api/subscriptions/${id}/${kind}`, { method: "POST", ...(opts.invoiceRemaining ? { body: JSON.stringify({ invoiceRemaining: true }) } : {}) });
      const done =
        kind === "pause"
          ? "Abonnement suspendu"
          : kind === "resume"
            ? "Abonnement repris"
            : opts.invoiceRemaining
              ? "Abonnement clôturé, échéances restantes facturées"
              : "Abonnement clôturé";
      const stripeDone =
        kind === "pause" ? "prélèvement Stripe suspendu" : kind === "resume" ? "prélèvement Stripe repris" : "prélèvement Stripe résilié";
      toast.success(viaStripe ? `${done} (${stripeDone})` : done);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    }
  }

  async function scheduleEnd(sub: Subscription) {
    try {
      const updated = await api<{ endDate: string | null }>(`/api/subscriptions/${sub.id}/schedule-end`, { method: "POST" });
      const day = updated.endDate ? formatDate(updated.endDate) : "";
      toast.success(sub.stripeSubscriptionId ? `Fin programmée : actif jusqu'au ${day}, prélèvement Stripe arrêté ensuite` : `Fin programmée : actif jusqu'au ${day}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    }
  }

  async function unscheduleEnd(sub: Subscription) {
    try {
      await api(`/api/subscriptions/${sub.id}/cancel-scheduled-end`, { method: "POST" });
      toast.success(sub.stripeSubscriptionId ? "Fin annulée : l'abonnement continue, prélèvement Stripe compris" : "Fin annulée : l'abonnement continue");
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

  // 1er onglet : les abonnements proposés (offres du catalogue) ; 2e : les contrats des clients.
  const [tab, setTab] = useTabParam(["offres", "contrats"] as const, "offres");
  const navigate = useNavigate();
  const activeOffers = offers.filter((o) => o.active);
  const archivedOffers = offers.filter((o) => !o.active);
  // Offres archivées dans l'URL (?archivees=1), comme dans Prestations.
  const filters = useUrlFilters();
  const offerView = filters.params.get("archivees") === "1" ? "archived" : "active";
  const shownOffers = offerView === "active" ? activeOffers : archivedOffers;
  // ?contrat=<id> (lien depuis un devis de rachat) : ouvre la fiche du contrat.
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("contrat"));
  useEffect(() => {
    if (selectedId || !params.get("contrat")) return;
    const next = new URLSearchParams(params);
    next.delete("contrat");
    setParams(next, { replace: true });
  }, [selectedId, params, setParams]);
  const [endTarget, setEndTarget] = useState<Subscription | null>(null);
  /** Clôture pendant l'engagement : facturer les échéances restantes (coché par défaut, CGV « Départ anticipé »). */
  const [invoiceRemaining, setInvoiceRemaining] = useState(true);
  const [scheduleTarget, setScheduleTarget] = useState<Subscription | null>(null);
  const [unscheduleTarget, setUnscheduleTarget] = useState<Subscription | null>(null);
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
        <span className="flex flex-col items-end py-1">
          <span className="whitespace-nowrap tabular-nums">
            <span className="font-medium">{formatEUR(s.amountCents)}</span>{" "}
            <span className="text-[var(--muted)]">{periodSuffix(s.billingInterval)}</span>
          </span>
          {monthlyEquivalentText(s.amountCents, s.billingInterval) ? (
            <span className="whitespace-nowrap text-xs tabular-nums text-[var(--muted)]">{monthlyEquivalentText(s.amountCents, s.billingInterval)}</span>
          ) : null}
        </span>
      ),
    },
    {
      name: "Échéance",
      width: "10rem",
      showFrom: 1200,
      selector: (s) => s.nextInvoiceAt,
      sortable: true,
      cell: (s) => (
        <span className="whitespace-nowrap text-[var(--muted)]">
          {formatDate(s.nextInvoiceAt)}
          {s.commitmentEndsAt ? <span className="block text-xs">Engagé jusqu'au {formatDate(s.commitmentEndsAt)}</span> : null}
        </span>
      ),
    },
    {
      name: "Statut",
      width: "12rem",
      selector: (s) => s.status,
      cell: (s) => <SubscriptionBadges s={s} stripeEnabled={moduleStripeEnabled} />,
    },
  ];

  const clientGroups = [{ heading: "", options: clients.map((c) => ({ value: c.id, label: c.displayName })) }];
  const offerGroups = [{ heading: "", options: services.map((s) => catalogOption({ ...s, isSubscription: true })) }];

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
            {/* Même création que Prestations > Créer > Abonnement (Stripe compris, annuel par défaut). */}
            <Button variant="secondary" onClick={() => navigate("/services?new=abonnement")}>
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
              Nouvel abonnement
            </Button>
            <Button onClick={openCreate}>
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
              Nouveau contrat
            </Button>
          </>
        }
      />

      {rows.length > 0 ? (
        <StatStrip
          className="mb-6"
          items={(() => {
            const active = rows.filter((r) => r.status === "ACTIVE");
            const billing = active.filter((r) => !r.firstInvoicePending);
            const upcoming = active.filter((r) => r.firstInvoicePending);
            const next = active
              .map((r) => r.nextInvoiceAt)
              .filter(Boolean)
              .sort()[0];
            return [
              {
                label: "Revenu mensuel récurrent",
                shortLabel: "Revenu mensuel",
                value: formatEUR(
                  billing.reduce((acc, r) => acc + monthlyEquivalentCents(r.amountCents, r.billingInterval), 0),
                ),
                hint: [
                  billing.some((r) => normalizeInterval(r.billingInterval) !== "MONTH")
                    ? `Contrats facturés, ${billing.some((r) => normalizeInterval(r.billingInterval) === "YEAR") ? (billing.some((r) => normalizeInterval(r.billingInterval) === "QUARTER") ? "annuels et trimestriels" : "annuels") : "trimestriels"} ramenés au mois`
                    : "Contrats facturés",
                  upcoming.length > 0
                    ? `à venir : ${formatEUR(upcoming.reduce((acc, r) => acc + monthlyEquivalentCents(r.amountCents, r.billingInterval), 0))} (${upcoming.length} contrat${upcoming.length > 1 ? "s" : ""})`
                    : null,
                ]
                  .filter(Boolean)
                  .join(", "),
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
          { id: "offres", label: "Abonnements", count: activeOffers.length || null },
          { id: "contrats", label: "Contrats", count: rows.length || null },
        ]}
      >
        {tab === "contrats" ? (
            <DataTable
              columns={contractColumns}
              data={rows}
              loading={!loaded && !loadError}
              error={loadError}
              onRetry={reload}
              searchable={["client.displayName", "label", "service.name"]}
              searchPlaceholder="Rechercher un contrat…"
              countLabel={rows.length > 1 ? "contrats" : "contrat"}
              emptyTitle="Aucun contrat"
              emptyHint="Un contrat relie un client à un abonnement : chaque échéance est facturée automatiquement. Bouton « Nouveau contrat »."
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
                      {monthlyEquivalentText(s.amountCents, s.billingInterval) ? (
                        <span className="block text-xs text-[var(--muted)]">{monthlyEquivalentText(s.amountCents, s.billingInterval)}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex w-full flex-wrap items-center justify-between gap-2 text-sm text-[var(--muted)]">
                    <span>
                      Prochaine facture : {formatDate(s.nextInvoiceAt)}
                      {s.commitmentEndsAt ? <span className="block">Engagé jusqu'au {formatDate(s.commitmentEndsAt)}</span> : null}
                    </span>
                    <SubscriptionBadges s={s} stripeEnabled={moduleStripeEnabled} />
                  </span>
                </button>
              )}
            />
        ) : (
            <Card className="overflow-hidden">
              {archivedOffers.length > 0 || offerView === "archived" ? (
                <div className="border-b border-[var(--border)] p-3 sm:p-4">
                  <FilterBar>
                    <FilterSegment
                      label="État"
                      value={offerView}
                      onChange={(v) => filters.set({ archivees: v === "archived" ? "1" : null })}
                      options={[
                        { id: "active", label: "Actives", count: activeOffers.length },
                        { id: "archived", label: "Archivées", count: archivedOffers.length },
                      ]}
                    />
                  </FilterBar>
                </div>
              ) : null}
              {loadError || !loaded ? (
                <LoadState loading={!loadError} error={loadError} onRetry={reload}>
                  {null}
                </LoadState>
              ) : offerView === "archived" && archivedOffers.length === 0 ? (
                <EmptyState title="Aucun abonnement archivé." />
              ) : offerView === "active" && activeOffers.length === 0 ? (
                <EmptyState
                  title="Aucun abonnement."
                  hint="Hébergement, maintenance… : l'offre que vos contrats reprennent ensuite."
                  action={
                    <Button onClick={() => navigate("/services?new=abonnement")}>
                      <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
                      Créer un abonnement
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {shownOffers
                    .map((o) => (
                      <li
                        key={o.id}
                        className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-[var(--surface-raised)] sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{o.name}</p>
                            {!o.active ? <Badge tone="neutral">Archivée</Badge> : null}
                          </div>
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
                            {monthlyEquivalentText(o.unitPriceCents, o.billingInterval) ? (
                              <p className="text-xs text-[var(--muted)]">{monthlyEquivalentText(o.unitPriceCents, o.billingInterval)}</p>
                            ) : null}
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
                            {!o.active && !o.stripeProductId ? (
                              <Button variant="secondary" className="px-3 text-sm" onClick={() => void restoreOffer(o)}>
                                Réactiver
                              </Button>
                            ) : null}
                            {o.active ? (
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
        title="Archiver cette offre"
        message={`« ${offerToArchive?.name ?? ""} » ne sera plus proposée ; elle reste dans « Archivées ». Les contrats en cours ne changent pas.${offerToArchive?.stripeProductId ? " Elle est aussi archivée dans Stripe : les prélèvements en cours continuent." : ""}`}
        confirmLabel="Archiver"
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
                  {monthlyEquivalentText(selected.amountCents, selected.billingInterval) ? (
                    <span className="block text-xs font-normal text-[var(--muted)]">{monthlyEquivalentText(selected.amountCents, selected.billingInterval)}</span>
                  ) : null}
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
              {selected.endDate && selected.status !== "ENDED" ? (
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--muted)]">Fin programmée</dt>
                  <dd className="mt-0.5">Actif jusqu'au {formatDate(selected.endDate)}</dd>
                </div>
              ) : null}
              {selected.commitmentEndsAt ? (
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--muted)]">Engagement</dt>
                  <dd className="mt-0.5">
                    {selected.commitmentMonths} mois, jusqu'au {formatDate(selected.commitmentEndsAt)}
                  </dd>
                </div>
              ) : null}
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
            <BuyoutSection subscriptionId={selected.id} />
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
              {selected.status !== "ENDED" && selected.scheduledEndAt && !selected.endDate ? (
                <Button variant="secondary" onClick={() => fromPanel(() => setScheduleTarget(selected))}>
                  <FontAwesomeIcon icon={faCalendarXmark} className="h-3.5 w-3.5" aria-hidden />
                  Programmer la fin
                </Button>
              ) : null}
              {selected.status !== "ENDED" && selected.endDate ? (
                <Button variant="secondary" onClick={() => fromPanel(() => setUnscheduleTarget(selected))}>
                  <FontAwesomeIcon icon={faRotateLeft} className="h-3.5 w-3.5" aria-hidden />
                  Annuler la fin programmée
                </Button>
              ) : null}
              {selected.status !== "ENDED" ? (
                <Button variant="danger-ghost" onClick={() => fromPanel(() => setEndTarget(selected))}>
                  <FontAwesomeIcon icon={faStop} className="h-3.5 w-3.5" aria-hidden />
                  Clôturer
                </Button>
              ) : null}
              {selected.draftLike ? (
                <Button variant="danger-ghost" onClick={() => fromPanel(() => setDeleteTarget(selected))}>
                  <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
                  Supprimer
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Supprimer ce contrat"
        message={`« ${deleteTarget?.label ?? ""} » (${deleteTarget?.client.displayName ?? ""}) n'a jamais été facturé : il est supprimé définitivement. Un contrat déjà facturé se clôture.`}
        confirmLabel="Supprimer"
        danger
        busy={deleteBusy}
        onConfirm={() => deleteTarget && void deleteContract(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(scheduleTarget)}
        title="Programmer la fin de cet abonnement"
        message={`« ${scheduleTarget?.label ?? ""} » (${scheduleTarget?.client.displayName ?? ""}) reste actif jusqu'au ${scheduleTarget?.scheduledEndAt ? lastDayOf(scheduleTarget.scheduledEndAt) : ""}, fin de ${scheduleTarget?.commitmentEndsAt ? "son terme en cours" : "sa période en cours"}, puis prend fin sans frais : aucune facture${scheduleTarget?.stripeSubscriptionId ? " ni prélèvement Stripe" : ""} ensuite. Les factures déjà émises ne changent pas.`}
        confirmLabel="Programmer la fin"
        onConfirm={() => {
          if (scheduleTarget) void scheduleEnd(scheduleTarget);
          setScheduleTarget(null);
        }}
        onClose={() => setScheduleTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(unscheduleTarget)}
        title="Annuler la fin programmée"
        message={`« ${unscheduleTarget?.label ?? ""} » (${unscheduleTarget?.client.displayName ?? ""}) ne prend plus fin le ${unscheduleTarget?.endDate ? formatDate(unscheduleTarget.endDate) : ""} : il continue et se reconduit comme avant${unscheduleTarget?.stripeSubscriptionId ? ", prélèvement Stripe compris" : ""}.`}
        confirmLabel="Annuler la fin"
        onConfirm={() => {
          if (unscheduleTarget) void unscheduleEnd(unscheduleTarget);
          setUnscheduleTarget(null);
        }}
        onClose={() => setUnscheduleTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(endTarget)}
        title="Clôturer cet abonnement"
        message={`« ${endTarget?.label ?? ""} » (${endTarget?.client.displayName ?? ""}) : plus aucune facture ne sera émise${endTarget?.stripeSubscriptionId ? " et le prélèvement Stripe sera résilié" : ""}. Les factures déjà émises ne changent pas.`}
        confirmLabel="Clôturer"
        danger
        onConfirm={() => {
          if (endTarget) void action(endTarget.id, "end", { invoiceRemaining: Boolean(endTarget.remainingCommitment) && invoiceRemaining });
          setEndTarget(null);
          setInvoiceRemaining(true);
        }}
        onClose={() => {
          setEndTarget(null);
          setInvoiceRemaining(true);
        }}
      >
        {endTarget?.remainingCommitment ? (
          <div className="mt-3 space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
            <p className="text-[var(--text)]">
              {`Encore engagé jusqu'au ${formatDate(endTarget.remainingCommitment.until)} : ${endTarget.remainingCommitment.count} échéance${endTarget.remainingCommitment.count > 1 ? "s" : ""} restent dues après la période en cours (CGV, départ anticipé).`}
            </p>
            <Checkbox
              label={`Facturer les échéances restantes : ${endTarget.remainingCommitment.count} × ${formatEUR(endTarget.amountCents)}, soit ${formatEUR(endTarget.remainingCommitment.amountCents)}`}
              hint="Une facture est émise et envoyée au client avant la clôture. Décochez pour clôturer sans rien facturer."
              checked={invoiceRemaining}
              onChange={(e) => setInvoiceRemaining(e.target.checked)}
            />
          </div>
        ) : null}
      </ConfirmDialog>

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
          <Field label="Client" error={missing.clientId ? "Choisissez le client." : undefined}>
            <Combobox
              id="subscription-client"
              label="Client"
              groups={clientGroups}
              value={form.clientId}
              placeholder="Choisir un client"
              searchPlaceholder="Nom ou numéro de client"
              emptyText="Aucun client ne correspond."
              onChange={(clientId) => {
                // Jour de prélèvement du client par défaut (modifiable pour cet abonnement).
                const day = clients.find((c) => c.id === clientId)?.billingDay;
                setForm({ ...form, clientId, ...(day ? { billingDay: String(day) } : {}) });
                setMissing((m) => ({ ...m, clientId: false }));
              }}
              disabled={!!editingId}
            />
          </Field>
          <Field
            label="Offre abonnement"
            error={missing.serviceId ? "Choisissez l'offre." : undefined}
            hint={(() => {
              // Le déclencheur tronque le nom sur mobile : le détail complet est repris dessous.
              const svc = services.find((s) => s.id === form.serviceId);
              return svc ? `${svc.name}, ${formatEUR(svc.unitPriceCents)} ${periodSuffix(svc.billingInterval)}` : undefined;
            })()}
          >
            <Combobox
              id="subscription-offer"
              label="Offre abonnement"
              groups={offerGroups}
              value={form.serviceId}
              placeholder="Choisir une offre"
              searchPlaceholder="Nom de l'offre"
              emptyText="Aucune offre ne correspond."
              onChange={(id) => {
                setMissing((m) => ({ ...m, serviceId: false }));
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
            />
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
              hint={
                editingId
                  ? editing?.draftLike
                    ? "Correction possible : rien n'a encore été facturé."
                    : "Contrat facturé, issu d'un devis ou prélevé par Stripe : « Réviser (avenant) »."
                  : undefined
              }
            >
              <Input
                required
                type="number"
                step="0.01"
                min="0"
                value={form.amountEuros}
                onChange={(e) => setForm({ ...form, amountEuros: e.target.value })}
                disabled={!!editingId && !editing?.draftLike}
              />
              {monthlyEquivalentText(eurosInputToCents(form.amountEuros), form.billingInterval) ? (
                <p className="mt-1 text-xs text-[var(--muted)]">{monthlyEquivalentText(eurosInputToCents(form.amountEuros), form.billingInterval)}</p>
              ) : null}
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
              <DateInput
                required
                value={form.startDate}
                onChange={(v) => setForm({ ...form, startDate: v })}
                disabled={!!editingId}
              />
            </Field>
            {firstInvoiceEditable ? (
              <Field
                className="sm:col-span-3"
                label="1re facture (facultatif)"
                hint="Vide : au prochain jour de prélèvement. Pour offrir une période (ex. un an), la date de la 1re facture ; le client est prévenu 30 jours avant."
              >
                <DateInput
                  min={form.startDate}
                  value={form.firstInvoiceAt}
                  onChange={(v) => setForm({ ...form, firstInvoiceAt: v })}
                />
              </Field>
            ) : null}
            {!editingId ? (
              <Field
                label="Engagement"
                hint="Puis reconduit chaque année ; le client demande la non-reconduction depuis son espace au plus tard un mois avant l'échéance, vous la traitez."
              >
                <Select value={form.commitmentMonths} onChange={(e) => setForm({ ...form, commitmentMonths: e.target.value })}>
                  <option value="12">12 mois</option>
                  <option value="24">24 mois</option>
                  <option value="36">36 mois</option>
                </Select>
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
                options={REVISE_INTERVAL_OPTIONS}
                value={reviseInterval}
                onChange={changeReviseInterval}
                className="w-full"
              />
            </div>
          )}
          <Field label={`Nouveau montant par ${periodWord(reviseInterval)} (€)`}>
            <Input
              required
              type="number"
              step="0.01"
              min="0.01"
              value={reviseAmount}
              onChange={(e) => setReviseAmount(e.target.value)}
            />
            {monthlyEquivalentText(eurosInputToCents(reviseAmount), reviseInterval) ? (
              <p className="mt-1 text-xs text-[var(--muted)]">{monthlyEquivalentText(eurosInputToCents(reviseAmount), reviseInterval)}</p>
            ) : null}
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
              ? `Passage ${reviseInterval === "YEAR" ? "à l'annuel" : reviseInterval === "QUARTER" ? "au trimestriel" : "au mensuel"} : il s'applique à la prochaine échéance (${formatDate(revising.nextInvoiceAt)}) si le client accepte le devis avant. La période en cours reste facturée comme prévu.`
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
            <Field
              label={normalizeInterval(editingOffer ? editingOffer.billingInterval : "YEAR") === "YEAR" ? "Prix / an (€)" : "Prix / mois (€)"}
              hint={editingOffer ? "Vaut pour les nouveaux contrats ; ceux en cours gardent leur montant (avenant pour le changer)." : undefined}
            >
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
              {monthlyEquivalentText(eurosInputToCents(offerForm.unitPriceEuros), editingOffer ? editingOffer.billingInterval : "YEAR") ? (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {monthlyEquivalentText(eurosInputToCents(offerForm.unitPriceEuros), editingOffer ? editingOffer.billingInterval : "YEAR")}
                </p>
              ) : null}
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
                    {normalizeInterval(editingOffer ? editingOffer.billingInterval : "YEAR") === "YEAR" ? `Le ${d} du mois anniversaire` : `Le ${d} de chaque mois`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Prestation de rachat (facultatif)"
            hint="Prestation ponctuelle du catalogue, au prix du catalogue : « Proposer le rachat » sur la fiche d'un contrat à cette offre crée le devis. Vide : pas de rachat."
          >
            <Select value={offerForm.buyoutServiceId} onChange={(e) => setOfferForm({ ...offerForm, buyoutServiceId: e.target.value })}>
              <option value="">Pas de rachat</option>
              {oneOffs
                .filter((x) => x.active !== false || x.id === offerForm.buyoutServiceId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {`${x.name} (${formatEUR(x.unitPriceCents)})${x.active === false ? ", archivée" : ""}`}
                  </option>
                ))}
            </Select>
          </Field>
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
