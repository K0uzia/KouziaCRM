import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientNeed } from "@/components/clients/NeedsEditor";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { useLiveRefresh } from "@/lib/notifications";
import { api, formatEUR } from "@/lib/api";
import {
  formatDate,
  formatDecimal,
  invoiceStatusLabel,
  quoteStatusLabel,
  statusTone,
} from "@/lib/format";
import { Button, buttonClass } from "@/components/ui/Button";
import { MoreMenu } from "@/components/ui/MoreMenu";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { FilterChips } from "@/components/ui/FilterChips";
import { StatStrip, type StatItem } from "@/components/ui/StatStrip";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { DocumentFormEditor } from "@/components/documents/DocumentForm";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { InvoiceTypeBadge } from "@/components/documents/InvoiceTypeBadge";
import { MarketTimeline, type MarketMilestone, type MarketView } from "@/components/documents/MarketTimeline";
import { AcceptanceProofs } from "@/components/documents/AcceptanceProofs";
import { QuoteJourney } from "@/components/documents/QuoteJourney";
import {
  ManualPaymentDialog,
  type ManualPaymentInput,
} from "@/components/payments/ManualPaymentDialog";
import { PaymentForm } from "@/components/payments/PaymentForm";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { ClientEmailLink } from "@/components/clients/ClientEmailLink";
import { CreditNoteWizard } from "@/components/documents/CreditNoteWizard";
import { buildBillingEmailDraft, buildIssueEmailDraft } from "@/lib/issue-email";
import {
  BillingDialog,
  PaymentLinkFields,
  paymentChoiceOf,
  paymentFieldsValid,
  type BillingRequest,
  type PaymentFieldsState,
} from "@/components/documents/BillingDialog";
import { useCreateParam } from "@/lib/use-create-param";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Milestone = {
  id: string;
  label: string;
  percentBps: number;
  amountCents: number;
  triggerText: string;
  status: string;
  position: number;
  invoiceId?: string | null;
};

type Doc = {
  id: string;
  number: string | null;
  status: string;
  quoteStatus?: string | null;
  quoteDecidedAt?: string | null;
  quoteSignerName?: string | null;
  quoteRejectReason?: string | null;
  documentType: string;
  invoiceType?: string;
  quoteId?: string | null;
  sourceQuoteId?: string | null;
  checkoutUrl?: string | null;
  /** Échéance Stripe marquée non recouvrable dans Stripe : reste émise et impayée, sans relance. */
  stripeUncollectibleAt?: string | null;
  quote?: { id: string; number: string | null } | null;
  subtotalCents?: number;
  totalCents: number;
  discountType?: string;
  discountValue?: number;
  issueDate: string | null;
  serviceDate?: string | null;
  purchaseOrderRef?: string | null;
  validUntil: string | null;
  notes: string | null;
  paymentTerms: string | null;
  /** Devis : formules proposées (TWO | THREE | CHOICE) et formule retenue à la signature. */
  paymentPlanOffer?: string | null;
  /** Devis : base de l'acompte et de l'échéancier (partie ponctuelle) ; null pour un devis antérieur. */
  depositBaseCents?: number | null;
  paymentPlan?: string | null;
  client: {
    id: string;
    displayName: string;
    clientNumber?: string | null;
    email?: string | null;
  };
  payments?: Array<{ id: string; amountCents: number; paidAt: string; method: string }>;
  bankTransactions?: Array<{
    id: string;
    bookedAt: string;
    amountCents: number;
    counterpartyName: string | null;
    reference: string | null;
    status: string;
  }>;
  lines?: Array<{
    description: string;
    quantity: number | string;
    unitPriceCents: number;
    lineTotalCents: number;
    isSubscription?: boolean;
    billingDay?: number | null;
    billingInterval?: string | null;
    serviceId?: string | null;
    subscriptionId?: string | null;
  }>;
  milestones?: Milestone[];
};

// needs : rappel des besoins du client dans le formulaire de devis.
type ClientOpt = { id: string; displayName: string; clientNumber?: string | null; needs?: ClientNeed[] };

function displayStatus(d: Doc, isQuote: boolean): string {
  if (isQuote && d.quoteStatus) return d.quoteStatus;
  return d.status;
}

function DocumentsListPage({
  documentType,
}: {
  documentType: "INVOICE" | "QUOTE";
}) {
  const navigate = useNavigate();
  const isQuote = documentType === "QUOTE";
  const [rows, setRows] = useState<Doc[]>([]);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  // Client présélectionné (lien « Nouveau devis » d'une fiche client), sinon le formulaire choisit.
  const [createClientId, setCreateClientId] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const openCreate = useCallback((params?: { clientId?: string }) => {
    setCreateClientId(params?.clientId);
    setCreateOpen(true);
  }, []);

  useCreateParam(openCreate);

  async function load() {
    const [docs, cls] = await Promise.all([
      api<Doc[]>(`/api/invoices?type=${documentType}`),
      api<ClientOpt[]>("/api/clients"),
    ]);
    setRows(docs);
    setClients(cls);
  }

  useEffect(() => {
    load()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [documentType]);

  useLiveRefresh(() => void load().catch(() => undefined), (i) => i.kind === "quote_accepted" || i.kind === "quote_rejected" || i.kind === "payment");

  const filtered = useMemo(() => {
    if (statusFilter === "ALL") return rows;
    return rows.filter((r) => displayStatus(r, isQuote) === statusFilter);
  }, [rows, statusFilter, isQuote]);

  const labels = isQuote ? quoteStatusLabel : invoiceStatusLabel;
  const filters = isQuote
    ? ["ALL", "DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]
    : ["ALL", "DRAFT", "ISSUED", "PAID", "CANCELLED"];

  const renderDocCard = (d: Doc) => {
    const st = displayStatus(d, isQuote);
    return (
      <Link
        to={isQuote ? `/quotes/${d.id}` : `/invoices/${d.id}`}
        className="block min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)]"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <DocumentNumberBadge
              number={d.number}
              documentType={d.documentType}
              invoiceType={d.invoiceType}
            />
            <InvoiceTypeBadge type={d.documentType === "CREDIT_NOTE" ? "CREDIT_NOTE" : d.invoiceType} compact />
          </span>
          <span className="font-semibold tabular-nums">{formatEUR(d.totalCents)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="line-clamp-2 min-w-0 break-words text-sm">{d.client.displayName}</span>
          <span className="flex flex-wrap justify-end gap-1">
            <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
            {d.stripeUncollectibleAt ? <Badge tone="red">Non recouvrable</Badge> : null}
          </span>
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">{formatDate(d.issueDate)}</p>
      </Link>
    );
  };

  const detailPath = (d: Doc) => (isQuote ? `/quotes/${d.id}` : `/invoices/${d.id}`);

  const docColumns: DataColumn<Doc>[] = [
    {
      name: "Numéro",
      selector: (d) => d.number ?? "",
      sortable: true,
      width: "12.5rem",
      // Gabarit unique : ligne 1 numéro et type, ligne 2 devis d'origine en texte secondaire.
      cell: (d) => (
        <div className="min-w-0 py-1">
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Link to={detailPath(d)} className="rounded-[var(--radius-sm)] hover:opacity-80">
              <DocumentNumberBadge number={d.number} documentType={d.documentType} invoiceType={d.invoiceType} />
            </Link>
            <InvoiceTypeBadge type={d.documentType === "CREDIT_NOTE" ? "CREDIT_NOTE" : d.invoiceType} compact />
          </div>
          {!isQuote && (d.quote?.number || d.quoteId) ? (
            <Link
              to={`/quotes/${d.quoteId ?? d.quote?.id}`}
              className="mt-0.5 block text-[length:var(--text-meta)] text-[var(--muted)] hover:text-[var(--primary)]"
              onClick={(e) => e.stopPropagation()}
            >
              Devis {d.quote?.number ?? ""}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      name: "Client",
      selector: (d) => d.client.displayName,
      sortable: true,
      grow: 3,
      cell: (d) => (
        <div className="min-w-0">
          <p className="line-clamp-2 break-words font-medium" title={d.client.displayName}>
            {d.client.displayName}
          </p>
          {d.client.clientNumber ? (
            <p className="font-mono text-xs text-[var(--muted)]">{d.client.clientNumber}</p>
          ) : null}
        </div>
      ),
    },
    {
      name: "Statut",
      selector: (d) => displayStatus(d, isQuote),
      sortable: true,
      width: "9rem",
      cell: (d) => {
        const st = displayStatus(d, isQuote);
        return (
          <span className="flex flex-col items-start gap-1 py-1">
            <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
            {d.stripeUncollectibleAt ? <Badge tone="red">Non recouvrable</Badge> : null}
          </span>
        );
      },
    },
    {
      name: "Émis le",
      selector: (d) => d.issueDate ?? "",
      sortable: true,
      width: "8.5rem",
      // Sous 1280 px, le nom du client passe avant la date (visible sur la fiche et en carte).
      showFrom: 1280,
      cell: (d) => <span className="text-[var(--muted)]">{d.issueDate ? formatDate(d.issueDate) : "Brouillon"}</span>,
    },
    ...((isQuote
      ? [
          {
            name: "Valable jusqu'au",
            selector: (d: Doc) => d.validUntil ?? "",
            sortable: true,
            width: "10.5rem",
            showFrom: 1280,
            cell: (d: Doc) => <span className="text-[var(--muted)]">{d.validUntil ? formatDate(d.validUntil) : "-"}</span>,
          },
        ]
      : []) as DataColumn<Doc>[]),
    {
      name: "Montant",
      selector: (d) => d.totalCents,
      sortable: true,
      width: "8.5rem",
      right: true,
      cell: (d) => <span className="font-semibold tabular-nums">{formatEUR(d.totalCents)}</span>,
    },
  ];

  const count = (st: string) => rows.filter((r) => displayStatus(r, isQuote) === st).length;
  const sum = (st: string) =>
    rows.filter((r) => displayStatus(r, isQuote) === st).reduce((acc, r) => acc + r.totalCents, 0);
  const decided = count("ACCEPTED") + count("REJECTED");
  const stats: StatItem[] = isQuote
    ? [
        { label: "En attente de réponse", value: formatEUR(sum("SENT")), hint: `${count("SENT")} devis envoyé${count("SENT") > 1 ? "s" : ""}`, tone: "primary" },
        { label: "Acceptés", value: formatEUR(sum("ACCEPTED")), hint: `${count("ACCEPTED")} devis`, tone: "success" },
        { label: "Taux d'acceptation", value: decided ? `${Math.round((count("ACCEPTED") / decided) * 100)} %` : "-", hint: decided ? `sur ${decided} décidé${decided > 1 ? "s" : ""}` : "aucune décision" },
        { label: "Brouillons", value: String(count("DRAFT")), hint: "à émettre" },
      ]
    : [
        { label: "À encaisser", value: formatEUR(sum("ISSUED")), hint: `${count("ISSUED")} facture${count("ISSUED") > 1 ? "s" : ""} émise${count("ISSUED") > 1 ? "s" : ""}`, tone: "primary" },
        { label: "Encaissé", value: formatEUR(sum("PAID")), hint: `${count("PAID")} payée${count("PAID") > 1 ? "s" : ""}`, tone: "success" },
        { label: "Total facturé", value: formatEUR(sum("ISSUED") + sum("PAID")), hint: "hors brouillons et annulées" },
        { label: "Brouillons", value: String(count("DRAFT")), hint: "à émettre" },
      ];

  return (
    <div>
      <PageHeader
        title={isQuote ? "Devis" : "Factures"}
        subtitle={
          isQuote
            ? "Propositions envoyées aux clients et leur décision."
            : "Factures émises, encaissements et soldes restants."
        }
        actions={
          <Button onClick={() => openCreate()}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            {isQuote ? "Nouveau devis" : "Nouvelle facture"}
          </Button>
        }
      />

      {loading ? (
        <div className="space-y-4" aria-busy="true">
          <div className="ui-card h-24 animate-pulse" />
          <div className="ui-card h-64 animate-pulse" />
        </div>
      ) : (
        <div className="space-y-5">
          {rows.length > 0 ? <StatStrip items={stats} /> : null}
          <DataTable
            columns={docColumns}
            renderMobileCard={renderDocCard}
            data={filtered}
            pagination
            perPage={25}
            onRowClick={(d) => navigate(detailPath(d))}
            countLabel={isQuote ? "devis" : filtered.length > 1 ? "factures" : "facture"}
            toolbar={
              <FilterChips
                label={isQuote ? "Filtrer les devis par statut" : "Filtrer les factures par statut"}
                value={statusFilter}
                onChange={setStatusFilter}
                options={filters.map((st) => ({
                  id: st,
                  label: st === "ALL" ? "Tous" : labels[st] ?? st,
                  count: st === "ALL" ? rows.length : count(st),
                }))}
              />
            }
            searchable={["number", "client.displayName", "client.clientNumber"]}
            searchPlaceholder={isQuote ? "Rechercher un devis ou un client" : "Rechercher une facture ou un client"}
            emptyTitle={isQuote ? "Aucun devis" : "Aucune facture"}
            emptyHint={
              rows.length === 0
                ? isQuote
                  ? "Créez votre premier devis avec le bouton Nouveau devis."
                  : "Créez votre première facture avec le bouton Nouvelle facture."
                : "Aucun document ne correspond à ces filtres."
            }
          />
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={isQuote ? "Nouveau devis" : "Nouvelle facture"}
        description="Ajoutez les lignes de prestation puis enregistrez le brouillon."
        wide
      >
        <DocumentFormEditor
          mode="create"
          documentType={documentType}
          clients={clients}
          initial={createClientId ? { clientId: createClientId } : undefined}
          onCancel={() => setCreateOpen(false)}
          onSuccess={(doc) => {
            setCreateOpen(false);
            navigate(isQuote ? `/quotes/${doc.id}` : `/invoices/${doc.id}`);
          }}
        />
      </Modal>
    </div>
  );
}

export function QuotesPage() {
  return <DocumentsListPage documentType="QUOTE" />;
}

export function InvoicesPage() {
  return <DocumentsListPage documentType="INVOICE" />;
}

/**
 * Devis accepté en 3 fois : où en est le 2e acompte. Il devient exigible quand l'étape de projet
 * cochée « Déclenche le 2e acompte » est faite ; la facture reste à émettre ici (« Facturer »).
 */
function Deposit2Notice({ milestone, clientId }: { milestone: MarketMilestone | null; clientId: string }) {
  if (!milestone) return null;
  const projectLink = (
    <Link to={`/clients/${clientId}?tab=projets`} className="link inline-flex min-h-11 items-center">
      Ouvrir le projet du client
    </Link>
  );
  if (milestone.status === "PENDING") {
    return (
      <div role="status" className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-2 text-sm">
        <p>
          <span className="font-medium">Paiement en 3 fois.</span> Le 2e acompte ({formatEUR(milestone.amountCents)}) devient
          exigible quand l&apos;étape cochée « Déclenche le 2e acompte » du projet est faite.
        </p>
        {projectLink}
      </div>
    );
  }
  if (milestone.status === "DUE" && !milestone.invoiceId) {
    return (
      <div
        role="status"
        className="rounded-[var(--radius)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] px-4 py-3 text-sm text-[var(--text)]"
      >
        <span className="font-medium">2e acompte exigible</span>
        {milestone.triggerStepLabel ? <> : étape « {milestone.triggerStepLabel} » faite</> : null}
        {milestone.triggeredAt ? <> le {formatDate(milestone.triggeredAt)}</> : null}. Émettez la facture
        d&apos;acompte depuis l&apos;échéancier ci-dessous.
      </div>
    );
  }
  return null;
}

export function DocumentDetailPage({ kind }: { kind: "INVOICE" | "QUOTE" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const isQuote = kind === "QUOTE";
  const [doc, setDoc] = useState<Doc | null>(null);
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [avoirOpen, setAvoirOpen] = useState(false);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [linked, setLinked] = useState<Doc[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payingMilestoneId, setPayingMilestoneId] = useState<string | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [sendEmailOnIssue, setSendEmailOnIssue] = useState(true);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [companyName, setCompanyName] = useState("Alexandre Kouziaeff");
  const [forceSoldeMessage, setForceSoldeMessage] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signPlan, setSignPlan] = useState<"TWO" | "THREE">("TWO");
  const [signBusy, setSignBusy] = useState(false);

  async function signOffline() {
    setSignBusy(true);
    try {
      await api(`/api/quotes/${id}/sign-offline`, {
        method: "POST",
        body: JSON.stringify({
          signerName: signerName.trim(),
          ...(doc?.paymentPlanOffer === "CHOICE" ? { paymentPlan: signPlan } : {}),
        }),
      });
      toast.success("Signature enregistrée : vous pouvez facturer l'acompte");
      setSignOpen(false);
      setSignerName("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setSignBusy(false);
    }
  }
  const [rejectReason, setRejectReason] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [invoiceModalBusy, setInvoiceModalBusy] = useState(false);
  // « Facturer » un acompte ou le solde : rien n'est émis avant validation de la fenêtre.
  const [billing, setBilling] = useState<
    | { kind: "ACOMPTE"; milestoneId: string; label: string; amountCents: number }
    | { kind: "SOLDE"; amountCents: number; force?: boolean }
    | null
  >(null);
  const [billingBusy, setBillingBusy] = useState(false);
  const [issuePayment, setIssuePayment] = useState<PaymentFieldsState>({ mode: "manual", url: "" });
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkPayment, setLinkPayment] = useState<PaymentFieldsState>({ mode: "manual", url: "" });
  const [linkSendEmail, setLinkSendEmail] = useState(true);
  const [startBusy, setStartBusy] = useState(false);

  /** Devis mixte signé : démarre l'abonnement sans attendre la fin du projet. */
  async function startSubscription() {
    if (!id) return;
    setStartBusy(true);
    try {
      await api(`/api/quotes/${id}/start-subscription`, { method: "POST" });
      toast.success("Abonnement démarré : lien de prélèvement envoyé, ou 1re facture émise sans Stripe");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Démarrage impossible");
    } finally {
      setStartBusy(false);
    }
  }

  async function load() {
    if (!id) return;
    const [d, cls] = await Promise.all([
      api<Doc>(`/api/invoices/${id}`),
      api<ClientOpt[]>("/api/clients"),
    ]);
    setDoc(d);
    setClients(cls);

    if (kind === "QUOTE") {
      try {
        setMarket(await api<MarketView>(`/api/quotes/${id}/market`));
      } catch {
        setMarket(null);
      }
      try {
        const siblings = await api<Doc[]>(`/api/invoices?type=INVOICE&market=${id}`);
        setLinked(siblings);
      } catch {
        setLinked([]);
      }
    } else if (d.quoteId) {
      try {
        const siblings = await api<Doc[]>(`/api/invoices?type=INVOICE&market=${d.quoteId}`);
        setLinked(siblings.filter((s) => s.id !== d.id));
        const m = await api<MarketView>(`/api/quotes/${d.quoteId}/market`);
        setMarket(m);
      } catch {
        setLinked([]);
      }
    } else {
      setLinked([]);
      setMarket(null);
    }
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
    api<{ legalName?: string; tradeName?: string | null }>("/api/settings")
      .then((s) => setCompanyName(s.tradeName || s.legalName || "Alexandre Kouziaeff"))
      .catch(() => undefined);
  }, [id]);

  // Devis accepté ou refusé, paiement reçu : la fiche ouverte se met à jour seule.
  useLiveRefresh(
    () => void load().catch(() => undefined),
    (i) => Boolean(id) && i.href.endsWith(`/${id}`),
  );

  if (!doc) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  const st = displayStatus(doc, isQuote);
  const labels = isQuote ? quoteStatusLabel : invoiceStatusLabel;
  const paid = (doc.payments ?? []).reduce((s, p) => s + p.amountCents, 0);
  const remaining = Math.max(0, doc.totalCents - paid);
  const hasMarket = Boolean(market?.milestones.length);
  const hasSimpleInvoice = linked.some((i) => i.invoiceType === "SIMPLE" || !i.invoiceType);
  const hasDepositInvoices = linked.some(
    (i) => i.invoiceType === "ACOMPTE" || i.invoiceType === "SOLDE",
  );
  // Ordre imposé : un devis ne se facture qu'une fois émis puis signé (règle vérifiée aussi par l'API).
  const quoteSigned = isQuote && Boolean(doc.number) && doc.quoteStatus === "ACCEPTED";
  // Devis d'abonnement seul (offre NONE figée à l'émission ; brouillon : déduit des lignes) :
  // ni acompte ni facture depuis le devis, l'abonnement facture chaque période.
  const docLines = doc.lines ?? [];
  const subscriptionQuote =
    isQuote &&
    (doc.paymentPlanOffer === "NONE" ||
      (doc.status === "DRAFT" && docLines.length > 0 && docLines.every((l) => l.isSubscription)));
  const canCreateInvoice = quoteSigned && !subscriptionQuote;
  // Devis mixte : l'abonnement démarre à la livraison (projet terminé) ; démarrage manuel possible.
  const mixedQuote =
    isQuote &&
    !subscriptionQuote &&
    docLines.some((l) => l.isSubscription) &&
    docLines.some((l) => !l.isSubscription) &&
    (doc.status === "DRAFT" || doc.depositBaseCents != null);
  const subscriptionToStart =
    mixedQuote && quoteSigned && docLines.some((l) => l.isSubscription && !l.subscriptionId);
  const lockedReason =
    doc.status === "DRAFT"
      ? "Étape 1 : émettez le devis (bouton Émettre) pour l'envoyer au client."
      : doc.quoteStatus === "SENT"
        ? "Étape 2 : en attente de la signature du client. Il signe depuis son espace client ; pour une signature papier ou par email, utilisez « Enregistrer la signature »."
        : "Ce devis ne peut plus être facturé.";
  const totalInvoiceDisabled = hasSimpleInvoice || hasDepositInvoices;

  function openIssueModal() {
    const draft = buildIssueEmailDraft(doc!, kind, companyName);
    setEmailSubject(draft.subject);
    setEmailBody(draft.body);
    setSendEmailOnIssue(Boolean(doc!.client.email));
    setIssuePayment({ mode: "manual", url: doc!.checkoutUrl ?? "" });
    setIssueOpen(true);
  }

  async function confirmBilling(req: BillingRequest) {
    if (!billing) return;
    setBillingBusy(true);
    try {
      const res =
        billing.kind === "ACOMPTE"
          ? await api<{ id: string; emailed?: boolean; emailReason?: string | null; warning?: string | null }>(
              `/api/quotes/${id}/milestones/${billing.milestoneId}/invoice`,
              { method: "POST", body: JSON.stringify(req) },
            )
          : await api<{ invoice: { id: string }; emailed?: boolean; emailReason?: string | null; warning?: string | null }>(
              `/api/quotes/${id}/balance-invoice`,
              { method: "POST", body: JSON.stringify({ ...req, force: Boolean(billing.force) }) },
            ).then((r) => ({ ...r, id: r.invoice.id }));
      const label = billing.kind === "ACOMPTE" ? "Facture d'acompte émise" : "Facture de solde émise";
      if (req.email.send) {
        if (res.emailed) toast.success(`${label} et envoyée au client`);
        else toast.success(`${label} (email non envoyé : ${res.emailReason === "smtp_off" ? "SMTP non configuré" : res.emailReason === "no_email" ? "adresse client manquante" : "envoi impossible"})`);
      } else {
        toast.success(label);
      }
      if (res.warning) toast.error(`Lien de paiement : ${res.warning}`);
      setBilling(null);
      navigate(`/invoices/${res.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur";
      if (billing.kind === "SOLDE" && !billing.force && msg.includes("force=true")) {
        setForceSoldeMessage(msg);
        return;
      }
      toast.error(msg);
    } finally {
      setBillingBusy(false);
    }
  }

  function openPaymentLink() {
    setLinkPayment({ mode: "manual", url: doc!.checkoutUrl ?? "" });
    setLinkSendEmail(Boolean(doc!.client.email));
    setLinkOpen(true);
  }

  async function savePaymentLinkOnInvoice(payment: ReturnType<typeof paymentChoiceOf>, sendEmail: boolean) {
    setLinkBusy(true);
    try {
      const res = await api<{ checkoutUrl: string | null; emailed: boolean }>(
        `/api/invoices/${id}/payment-link`,
        { method: "PUT", body: JSON.stringify({ payment, sendEmail }) },
      );
      toast.success(
        !res.checkoutUrl
          ? "Lien de paiement retiré"
          : res.emailed
            ? "Lien enregistré et facture renvoyée au client"
            : "Lien de paiement enregistré",
      );
      setLinkOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLinkBusy(false);
    }
  }

  async function confirmIssue() {
    setIssueBusy(true);
    try {
      const res = await api<{
        emailed?: boolean;
        emailReason?: string | null;
        subscriptionsCreated?: number;
        warning?: string | null;
        minimumWarning?: string | null;
      }>(`/api/invoices/${id}/issue`, {
        method: "POST",
        body: JSON.stringify({
          email: {
            send: sendEmailOnIssue,
            subject: emailSubject,
            body: emailBody,
          },
          ...(isQuote ? {} : { payment: paymentChoiceOf(issuePayment) }),
        }),
      });
      setIssueOpen(false);
      if (res.warning) toast.error(`Lien de paiement : ${res.warning}`);
      if (res.minimumWarning) toast.warning(res.minimumWarning, { duration: 12000 });
      const kindLabel = isQuote ? "Devis" : "Facture";
      if (sendEmailOnIssue && res.emailed) {
        toast.success(`${kindLabel} émis et envoyé par email`);
      } else if (sendEmailOnIssue && !res.emailed) {
        const why =
          res.emailReason === "smtp_off"
            ? "SMTP non configuré"
            : res.emailReason === "no_email"
              ? "adresse client manquante"
              : "envoi impossible";
        toast.success(`${kindLabel} émis (email non envoyé : ${why})`);
      } else {
        toast.success(`${kindLabel} émis`);
      }
      if (res.subscriptionsCreated && res.subscriptionsCreated > 0) {
        toast.success(
          `${res.subscriptionsCreated} abonnement(s) créé(s) (prochaine facture le mois suivant)`,
        );
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setIssueBusy(false);
    }
  }

  async function createTotalInvoice() {
    setInvoiceModalBusy(true);
    try {
      const inv = await api<{ id: string; subscriptionsCreated?: number }>(
        `/api/invoices/${id}/convert`,
        { method: "POST", body: "{}" },
      );
      toast.success("Facture créée depuis le devis");
      if (inv.subscriptionsCreated && inv.subscriptionsCreated > 0) {
        toast.success(
          `${inv.subscriptionsCreated} abonnement(s) créé(s) (prochaine facture le mois suivant)`,
        );
      }
      setInvoiceModalOpen(false);
      navigate(`/invoices/${inv.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setInvoiceModalBusy(false);
    }
  }

  function createMilestoneInvoice(milestoneId: string) {
    setInvoiceModalOpen(false);
    openDepositBilling(milestoneId);
  }

  function openDepositBilling(milestoneId: string) {
    const m = market?.milestones.find((x) => x.id === milestoneId);
    if (!m) return;
    setBilling({ kind: "ACOMPTE", milestoneId, label: m.label, amountCents: m.amountCents });
  }

  async function reject() {
    setRejectBusy(true);
    try {
      await api(`/api/invoices/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      });
      toast.success("Devis marqué comme refusé");
      setRejectOpen(false);
      setRejectReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setRejectBusy(false);
    }
  }

  async function manualPayMilestone(milestoneId: string, input: ManualPaymentInput) {
    setBusyId(`pay-${milestoneId}`);
    try {
      await api(`/api/quotes/${id}/milestones/${milestoneId}/pay-manual`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      toast.success("Acompte payé : le projet démarre");
      setPayingMilestoneId(null);
      await load();
      // Étape suivante du parcours : compléter le projet créé au paiement.
      const projects = await api<Array<{ id: string; quoteId: string | null }>>(
        `/api/clients/${doc!.client.id}/projects`,
      ).catch(() => []);
      const project = projects.find((p) => p.quoteId === doc!.id);
      if (project) navigate(`/clients/${doc!.client.id}?tab=projets&projet=${project.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusyId(null);
    }
  }

  async function savePaymentLink(
    milestoneId: string,
    checkoutUrl: string,
    sendEmail: boolean,
  ) {
    setBusyId(`link-${milestoneId}`);
    try {
      await api(`/api/quotes/${id}/milestones/${milestoneId}/payment-link`, {
        method: "POST",
        body: JSON.stringify({ checkoutUrl, sendEmail }),
      });
      toast.success(
        sendEmail
          ? "Lien enregistré et email d'encaissement envoyé"
          : "Lien de paiement enregistré",
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusyId(null);
    }
  }

  function generateSolde(force = false) {
    setBilling({ kind: "SOLDE", amountCents: market?.balance.balanceDueCents ?? 0, force });
  }

  async function sendReminder() {
    try {
      const res = await api<{ emailed: boolean; mailto: string | null }>(
        `/api/invoices/${id}/reminders/send`,
        { method: "POST", body: "{}" },
      );
      if (res.emailed) toast.success("Relance envoyée");
      else if (res.mailto) {
        window.location.href = res.mailto;
        toast.message("Client mail ouvert");
      } else toast.message("Relance enregistrée (pas d'email client)");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          doc.number ??
          (isQuote ? "Devis brouillon" : "Facture brouillon")
        }
        back={isQuote ? { to: "/quotes", label: "Devis" } : { to: "/invoices", label: "Factures" }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/clients/${doc.client.id}`} className="link inline-flex min-h-11 items-center">
              {doc.client.displayName}
            </Link>
            <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
            {doc.stripeUncollectibleAt ? <Badge tone="red">Non recouvrable (Stripe)</Badge> : null}
            {doc.invoiceType && doc.invoiceType !== "SIMPLE" ? (
              <InvoiceTypeBadge type={doc.invoiceType} />
            ) : null}
          </span>
        }
        actions={
          <>
            {doc.status === "DRAFT" ? (
              <>
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  Modifier
                </Button>
                <Button onClick={() => openIssueModal()}>Émettre</Button>
              </>
            ) : null}
            {doc.number ? (
              <a
                href={`/api/invoices/${doc.id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass("secondary")}
              >
                PDF
              </a>
            ) : null}
            {!isQuote && doc.status === "ISSUED" ? (
              <Button onClick={() => setPayOpen(true)}>Paiement</Button>
            ) : null}
            {isQuote && doc.number && doc.quoteStatus === "SENT" ? (
              <Button onClick={() => setSignOpen(true)}>Enregistrer la signature</Button>
            ) : null}
            {canCreateInvoice ? (
              <Button onClick={() => setInvoiceModalOpen(true)}>Créer une facture</Button>
            ) : null}
            <MoreMenu
              items={[
                ...(doc.number
                  ? [
                      {
                        label: resendBusy ? "Envoi…" : "Renvoyer par email",
                        disabled: resendBusy,
                        onSelect: () => {
                          setResendBusy(true);
                          void api<{ emailed: boolean }>(`/api/invoices/${doc.id}/send-email`, {
                            method: "POST",
                            body: "{}",
                          })
                            .then(() => toast.success("PDF en file d'envoi"))
                            .catch((e: Error) => toast.error(e.message))
                            .finally(() => setResendBusy(false));
                        },
                      },
                      { label: "Relancer le client", onSelect: () => void sendReminder() },
                    ]
                  : []),
                ...(isQuote && doc.quoteStatus === "SENT"
                  ? [{ label: "Marquer refusé par le client", onSelect: () => setRejectOpen(true) }]
                  : []),
                ...(!isQuote &&
                doc.documentType === "INVOICE" &&
                (doc.status === "ISSUED" || doc.status === "PAID")
                  ? [{ label: "Créer un avoir", danger: true, onSelect: () => setAvoirOpen(true) }]
                  : []),
              ]}
            />
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {/* Le document tel qu'il est émis */}
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-4 border-b border-[var(--border)] p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                  {isQuote
                    ? "Devis"
                    : doc.invoiceType === "ACOMPTE"
                      ? "Facture d'acompte"
                      : doc.invoiceType === "SOLDE"
                        ? "Facture de solde"
                        : "Facture"}
                </p>
                <p className="mt-1 font-mono text-lg text-[var(--primary)]">{doc.number ?? "Brouillon"}</p>
              </div>
              <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm sm:text-right">
                <dt className="text-[var(--muted)]">Émis le</dt>
                <dd>{doc.issueDate ? formatDate(doc.issueDate) : "Non émis"}</dd>
                {isQuote ? (
                  <>
                    <dt className="text-[var(--muted)]">Valable jusqu'au</dt>
                    <dd>{formatDate(doc.validUntil)}</dd>
                  </>
                ) : null}
                {doc.serviceDate ? (
                  <>
                    <dt className="text-[var(--muted)]">Prestation</dt>
                    <dd>{formatDate(doc.serviceDate)}</dd>
                  </>
                ) : null}
                {doc.purchaseOrderRef ? (
                  <>
                    <dt className="text-[var(--muted)]">Bon de commande</dt>
                    <dd className="font-mono text-xs">{doc.purchaseOrderRef}</dd>
                  </>
                ) : null}
              </dl>
            </div>

            <div className="border-b border-[var(--border)] px-5 py-4 sm:px-6">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Client</p>
              <Link
                to={`/clients/${doc.client.id}`}
                className="mt-1 inline-flex min-h-11 flex-wrap items-center gap-2 font-medium hover:text-[var(--primary)]"
              >
                {doc.client.displayName}
                {doc.client.clientNumber ? (
                  <span className="font-mono text-xs text-[var(--muted)]">{doc.client.clientNumber}</span>
                ) : null}
              </Link>
              {doc.client.email ? (
                <div className="mt-0.5 text-sm">
                  <ClientEmailLink
                    email={doc.client.email}
                    name={doc.client.displayName}
                    clientId={doc.client.id}
                    defaultSubject={`${isQuote ? "Devis" : "Facture"} ${doc.number ?? ""}`}
                    defaultTemplate={isQuote ? "quote_followup" : "invoice_reminder"}
                  />
                </div>
              ) : null}
            </div>

            <div className="ui-table-wrap max-md:overflow-visible">
              <table className="ui-table ui-table-stack w-full text-sm">
                <thead>
                  <tr className="bg-[var(--bg-subtle)] text-xs uppercase tracking-[0.06em] text-[var(--muted)]">
                    <th className="px-5 py-2.5 text-left font-semibold sm:px-6">Désignation</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Qté</th>
                    <th className="px-3 py-2.5 text-right font-semibold">P.U.</th>
                    <th className="px-5 py-2.5 text-right font-semibold sm:px-6">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(doc.lines ?? []).map((l, i) => (
                    <tr key={i} className="border-t border-[var(--border)]">
                      <td className="px-5 py-3 sm:px-6" data-label="Désignation">
                        {/* Un seul enfant : en cartes (mobile), la note ne devient pas une colonne étroite. */}
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{l.description}</span>
                            {l.isSubscription ? (
                              <Badge tone="amber">{l.billingInterval === "YEAR" ? "Annuel" : "Mensuel"}</Badge>
                            ) : null}
                          </div>
                          {l.isSubscription ? (
                            <p className="mt-1 max-w-xl text-xs text-[var(--muted)]">
                              {subscriptionQuote || mixedQuote
                                ? `Facturé chaque ${l.billingInterval === "YEAR" ? "année" : "mois"} à partir ${
                                    subscriptionQuote ? "de la signature" : "de la livraison (projet terminé)"
                                  }, sans acompte.`
                                : `${l.billingInterval === "YEAR" ? "Facturé chaque année à la date anniversaire." : `Facturé le ${l.billingDay ?? "…"} de chaque mois.`} Ce document inclut la 1re échéance.`}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="w-16 px-3 py-3 text-right tabular-nums" data-label="Qté">
                        {String(l.quantity)}
                      </td>
                      <td className="w-28 px-3 py-3 text-right tabular-nums" data-label="P.U.">
                        {formatEUR(l.unitPriceCents)}
                      </td>
                      <td className="w-32 px-5 py-3 text-right font-medium tabular-nums sm:px-6" data-label="Total">
                        {formatEUR(l.lineTotalCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-4 border-t border-[var(--border)] p-5 sm:flex-row sm:justify-between sm:p-6">
              <div className="min-w-0 space-y-3 text-sm sm:max-w-md">
              {(doc.lines ?? []).some((l) => l.isSubscription) ? (
                <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-3 text-sm">
                  <p className="font-medium">
                    {(doc.lines ?? []).every((l) => !l.isSubscription || l.billingInterval === "YEAR")
                      ? "Récurrence annuelle"
                      : (doc.lines ?? []).some((l) => l.isSubscription && l.billingInterval === "YEAR")
                        ? "Récurrence"
                        : "Récurrence mensuelle"}
                  </p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[var(--muted)]">
                    {(doc.lines ?? [])
                      .filter((l) => l.isSubscription)
                      .map((l, i) => (
                        <li key={i}>
                          <span className="text-[var(--text)]">{l.description}</span>
                          {" : "}
                          {formatEUR(l.unitPriceCents)} facturés{" "}
                          {subscriptionQuote || mixedQuote
                            ? `${l.billingInterval === "YEAR" ? "chaque année" : "chaque mois"} à partir ${
                                subscriptionQuote ? "de la signature" : "de la livraison (projet terminé)"
                              }, sans acompte.`
                            : l.billingInterval === "YEAR"
                            ? "chaque année à la date anniversaire. Les années suivantes seront facturées automatiquement, avec un rappel au client 30 jours avant."
                            : `chaque mois${l.billingDay ? ` le ${l.billingDay}` : ""}. Les mois suivants seront facturés automatiquement.`}
                        </li>
                      ))}
                  </ul>
                  {mixedQuote ? (
                    <div className="mt-2 space-y-2 text-[var(--muted)]">
                      <p>
                        Acompte et échéancier portent sur la partie ponctuelle
                        {doc.depositBaseCents != null ? ` (${formatEUR(doc.depositBaseCents)})` : ""}. L&apos;abonnement
                        démarre quand le projet passe à « Terminé » : lien de prélèvement avec Stripe, sinon 1re facture.
                      </p>
                      {subscriptionToStart ? (
                        <Button variant="secondary" disabled={startBusy} onClick={() => void startSubscription()}>
                          {startBusy ? "Démarrage…" : "Démarrer l'abonnement maintenant"}
                        </Button>
                      ) : quoteSigned ? (
                        <Link to="/abonnements" className="link inline-flex min-h-11 items-center">
                          Voir les abonnements
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                  {subscriptionQuote ? (
                    <p className="mt-2 text-[var(--muted)]">
                      À la signature, l&apos;abonnement est créé : avec Stripe, le client met en place le prélèvement
                      depuis son espace et chaque échéance est prélevée puis facturée ; sans Stripe, la 1re facture part
                      tout de suite.{" "}
                      {quoteSigned ? (
                        <Link to="/abonnements" className="link">
                          Voir les abonnements
                        </Link>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              ) : null}
                {doc.paymentTerms ? (
                  <p className="text-[var(--muted)]">
                    <span className="text-[var(--text)]">Conditions :</span> {doc.paymentTerms}
                  </p>
                ) : null}
                {doc.notes ? <p className="whitespace-pre-wrap text-[var(--muted)]">{doc.notes}</p> : null}
              </div>
              <div className="w-full shrink-0 space-y-1.5 text-sm sm:w-64">
                {doc.discountType &&
                doc.discountType !== "NONE" &&
                (doc.subtotalCents ?? doc.totalCents) !== doc.totalCents ? (
                  <>
                    <p className="text-[var(--muted)]">
                      Sous-total : {formatEUR(doc.subtotalCents ?? doc.totalCents)}
                    </p>
                    <p className="text-[var(--muted)]">
                      Remise
                      {doc.discountType === "PERCENT"
                        ? ` (${formatDecimal((doc.discountValue ?? 0) / 100)} %)`
                        : ""}
                      : −
                      {formatEUR(
                        Math.max(0, (doc.subtotalCents ?? doc.totalCents) - doc.totalCents),
                      )}
                    </p>
                  </>
                ) : null}
                <div className="flex items-baseline justify-between border-t border-[var(--border)] pt-2">
                  <span className="font-medium">Total</span>
                  <span className="font-display text-2xl font-semibold tabular-nums">{formatEUR(doc.totalCents)}</span>
                </div>
              </div>
            </div>
          </Card>

          {isQuote && doc.paymentPlan === "THREE" ? (
            <Deposit2Notice
              milestone={market?.milestones.find((m) => m.position === 2) ?? null}
              clientId={doc.client.id}
            />
          ) : isQuote && doc.paymentPlanOffer === "CHOICE" && doc.quoteStatus === "SENT" ? (
            <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--muted)]">
              Paiement au choix du client : il choisira 2 ou 3 fois à la signature.
            </p>
          ) : null}
          {isQuote && !subscriptionQuote && market && doc.quoteStatus !== "REJECTED" && doc.quoteStatus !== "EXPIRED" ? (
            <MarketTimeline
              market={market}
              busyId={busyId}
              onGenerateAcompte={(mid) => openDepositBilling(mid)}
              onGenerateSolde={(force) => generateSolde(Boolean(force))}
              onManualPay={(mid) => setPayingMilestoneId(mid)}
              onSavePaymentLink={(mid, url, send) => savePaymentLink(mid, url, send)}
              signed={quoteSigned}
              lockedReason={lockedReason}
            />
          ) : null}
          <ManualPaymentDialog
            open={Boolean(payingMilestoneId)}
            label={market?.milestones.find((m) => m.id === payingMilestoneId)?.label ?? ""}
            busy={busyId === `pay-${payingMilestoneId}`}
            onConfirm={(input) => payingMilestoneId && void manualPayMilestone(payingMilestoneId, input)}
            onClose={() => setPayingMilestoneId(null)}
          />


          {isQuote && linked.length > 0 ? (
            <Card className="overflow-hidden">
              <div className="flex min-h-11 items-center border-b border-[var(--border)] px-5">
                <h2 className="text-sm font-semibold">Factures issues de ce devis</h2>
              </div>
              <div className="px-5">
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {linked.map((inv) => (
                    <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <Link to={`/invoices/${inv.id}`} className="inline-flex min-h-11 items-center font-medium hover:text-[var(--primary)]">
                        {inv.invoiceType === "ACOMPTE"
                          ? "Acompte"
                          : inv.invoiceType === "SOLDE"
                            ? "Solde"
                            : "Facture"}{" "}
                        {inv.number ?? "Brouillon"}
                      </Link>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={resendBusy}
                          onClick={() => {
                            setResendBusy(true);
                            void api(`/api/invoices/${inv.id}/send-email`, {
                              method: "POST",
                              body: "{}",
                            })
                              .then(() => toast.success("PDF en file d'envoi"))
                              .catch((e: Error) => toast.error(e.message))
                              .finally(() => setResendBusy(false));
                          }}
                        >
                          Envoyer par email
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          ) : null}
        </div>

        {/* Synthèse */}
        <aside className="space-y-6" aria-label="Synthèse du document">
          <Card className="p-5 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-[var(--muted)]">{isQuote ? "Montant du devis" : "Montant de la facture"}</p>
                <p className="mt-1 font-display text-3xl font-semibold tabular-nums">{formatEUR(doc.totalCents)}</p>
              </div>
              <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
            </div>
            {!isQuote ? (
              <div className="mt-5">
                <div
                  className="h-2 overflow-hidden rounded-full bg-[var(--bg-subtle)]"
                  role="progressbar"
                  aria-label="Part encaissée"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={doc.totalCents > 0 ? Math.round(Math.min(100, (paid / doc.totalCents) * 100)) : 0}
                >
                  <div
                    className="h-full rounded-full bg-[var(--success)]"
                    style={{ width: `${doc.totalCents > 0 ? Math.min(100, (paid / doc.totalCents) * 100) : 0}%` }}
                  />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <dt className="text-xs text-[var(--muted)]">Encaissé</dt>
                    <dd className="font-semibold tabular-nums text-[var(--success)]">{formatEUR(paid)}</dd>
                  </div>
                  <div className="text-right">
                    <dt className="text-xs text-[var(--muted)]">Reste dû</dt>
                    <dd className="font-semibold tabular-nums">{formatEUR(remaining)}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
            {isQuote && doc.quoteDecidedAt ? (
              <div className="mt-4 border-t border-[var(--border)] pt-4">
                <p className="text-[var(--muted)]">
                  {doc.quoteStatus === "REJECTED" ? "Refusé le" : "Accepté le"}{" "}
                  {formatDate(doc.quoteDecidedAt)}
                </p>
                {doc.quoteSignerName ? (
                  <p className="mt-0.5">Bon pour accord : {doc.quoteSignerName}</p>
                ) : null}
                {doc.quoteRejectReason ? (
                  <p className="mt-0.5 whitespace-pre-wrap">{doc.quoteRejectReason}</p>
                ) : null}
              </div>
            ) : null}
            {isQuote && (doc.quoteStatus === "SENT" || doc.status === "DRAFT") ? (
              <p className="mt-4 border-t border-[var(--border)] pt-4 text-[var(--muted)]">
                <span className="font-medium text-[var(--text)]">Prochaine étape : </span>
                {doc.status === "DRAFT"
                  ? "émettre le devis pour lui attribuer un numéro et l'envoyer au client."
                  : `attendre la décision du client (offre valable jusqu'au ${formatDate(doc.validUntil)}). Il peut l'accepter en ligne depuis son espace client.`}
              </p>
            ) : null}
            {isQuote && doc.quoteStatus === "ACCEPTED" ? (
              <div className="mt-4">
                <AcceptanceProofs quoteId={doc.id} />
              </div>
            ) : null}
          </Card>

          {isQuote && doc.number && !subscriptionQuote ? (
            <Card className="p-5">
              <QuoteJourney
                quote={{
                  id: doc.id,
                  clientId: doc.client.id,
                  issueDate: doc.issueDate,
                  quoteStatus: doc.quoteStatus,
                  quoteDecidedAt: doc.quoteDecidedAt,
                }}
                milestones={market?.milestones ?? []}
              />
            </Card>
          ) : null}

          {!isQuote ? (
            <Card className="p-5 text-sm">
              <h2 className="mb-3 text-sm font-semibold">Paiements reçus</h2>
              {(doc.payments ?? []).length === 0 ? (
                <p className="text-[var(--muted)]">Aucun paiement enregistré.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {(doc.payments ?? []).map((p) => (
                    <li key={p.id} className="flex justify-between gap-2 py-2">
                      <span>{formatDate(p.paidAt)}</span>
                      <span className="font-medium tabular-nums">{formatEUR(p.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(doc.bankTransactions ?? []).length > 0 ? (
                <div className="border-t border-[var(--border)] pt-3">
                  <p className="mb-2 text-xs font-medium text-[var(--muted)]">
                    Transaction(s) bancaire(s)
                  </p>
                  <ul className="space-y-2">
                    {(doc.bankTransactions ?? []).map((t) => (
                      <li key={t.id} className="text-xs">
                        <span className="font-medium">{formatDate(t.bookedAt)}</span>
                        {" · "}
                        {formatEUR(t.amountCents)}
                        {t.counterpartyName ? ` · ${t.counterpartyName}` : ""}
                        {t.reference ? (
                          <span className="text-[var(--muted)]"> · {t.reference}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          ) : null}

          {!isQuote && doc.number && doc.status === "ISSUED" && remaining > 0 ? (
            <Card className="p-5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Paiement en ligne</h2>
                {doc.checkoutUrl ? <Badge tone="green">Lien actif</Badge> : <Badge tone="neutral">Aucun lien</Badge>}
              </div>
              {doc.checkoutUrl ? (
                <p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">{doc.checkoutUrl}</p>
              ) : (
                <p className="mt-2 text-[var(--muted)]">
                  Ajoutez un lien de paiement : il apparaît en bouton « Payer en ligne » dans l'email et l'espace client.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={openPaymentLink}>
                  {doc.checkoutUrl ? "Modifier le lien" : "Ajouter un lien"}
                </Button>
                {doc.checkoutUrl ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(doc.checkoutUrl!)
                        .then(() => toast.success("Lien copié"))
                        .catch(() => toast.error("Copie impossible"));
                    }}
                  >
                    Copier
                  </Button>
                ) : null}
              </div>
            </Card>
          ) : null}

          {!isQuote && (doc.quoteId || doc.sourceQuoteId || linked.length > 0) ? (
            <Card className="space-y-2 p-5 text-sm">
              <h2 className="mb-1 text-sm font-semibold">Documents liés</h2>
              {doc.quoteId || doc.sourceQuoteId ? (
                <Link to={`/quotes/${doc.quoteId ?? doc.sourceQuoteId}`} className="link-row">
                  <span>Devis d'origine</span>
                  <span className="link-row-muted font-mono text-xs">{doc.quote?.number ?? "Devis"}</span>
                </Link>
              ) : null}
              {linked.map((other) => (
                <Link key={other.id} to={`/invoices/${other.id}`} className="link-row">
                  <span className="font-mono text-xs">{other.number ?? "…"}</span>
                  <span className="link-row-muted tabular-nums">{formatEUR(other.totalCents)}</span>
                </Link>
              ))}
            </Card>
          ) : null}
        </aside>
      </div>

      <Modal
        open={signOpen}
        onClose={() => !signBusy && setSignOpen(false)}
        title="Enregistrer la signature du client"
        description="Pour un devis signé sur papier ou validé par email. La signature est tracée (date, auteur) dans la preuve d'acceptation."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void signOffline();
          }}
        >
          <Field label="Nom du signataire" hint="Tel qu'il figure sur le devis signé ou dans l'email d'accord.">
            <Input required minLength={2} maxLength={120} value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </Field>
          {doc.paymentPlanOffer === "CHOICE" ? (
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Formule retenue par le client</legend>
              {(
                [
                  ["TWO", "En 2 fois : acompte, puis solde à la livraison"],
                  ["THREE", "En 3 fois : acompte, 2e acompte à une étape du projet, solde"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="sign-plan"
                    value={value}
                    checked={signPlan === value}
                    onChange={() => setSignPlan(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ) : null}
          <ModalActions>
            <Button variant="secondary" disabled={signBusy} onClick={() => setSignOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={signBusy || signerName.trim().length < 2}>
              {signBusy ? "Enregistrement…" : "Enregistrer la signature"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal
        open={invoiceModalOpen}
        onClose={() => !invoiceModalBusy && setInvoiceModalOpen(false)}
        title="Créer une facture"
        description={
          doc.quoteStatus === "ACCEPTED"
            ? "Devis signé : facturez l'acompte. Une fois payé, le projet du client est créé et démarre."
            : "Le devis doit être signé par le client avant toute facture."
        }
      >
        <div className="space-y-4">
          {hasMarket ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Échéancier du devis</p>
              {market!.milestones.slice(0, -1).map((m, idx, deposits) => {
                const isFirst = idx === 0;
                const already = Boolean(m.invoiceId);
                const previousPaid = deposits.slice(0, idx).every((p) => p.status === "PAID");
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={invoiceModalBusy || already || !previousPaid || hasSimpleInvoice}
                    onClick={() => void createMilestoneInvoice(m.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-[var(--radius)] border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      isFirst && !already
                        ? "border-[var(--primary)]/60 bg-[var(--primary-soft)] hover:bg-[var(--primary)]/20"
                        : "border-[var(--border)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {m.label} ({(m.percentBps / 100).toFixed(0)} %)
                      </span>
                      <span className="block text-xs text-[var(--muted)]">
                        {already
                          ? "Déjà facturé"
                          : hasSimpleInvoice
                            ? "Devis déjà facturé en totalité"
                            : !previousPaid
                            ? "Après le paiement de l'acompte précédent"
                            : isFirst
                              ? "Étape suivante : son paiement crée le projet client"
                              : m.triggerText}
                      </span>
                    </span>
                    <span className="shrink-0 font-display text-lg font-semibold tabular-nums">{formatEUR(m.amountCents)}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">Facture totale, sans acompte</p>
                <p className="text-xs text-[var(--muted)]">
                  {totalInvoiceDisabled
                    ? hasSimpleInvoice
                      ? "Une facture totale existe déjà pour ce devis."
                      : "Des acomptes sont déjà facturés : passez par l'échéancier et la facture de solde."
                    : "Pour une petite prestation réglée en une fois. Le projet est créé à son paiement."}
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={invoiceModalBusy || totalInvoiceDisabled}
                onClick={() => void createTotalInvoice()}
              >
                {formatEUR(doc.totalCents)}
              </Button>
            </div>
          </div>

          <ModalActions>
            <Button variant="secondary" disabled={invoiceModalBusy} onClick={() => setInvoiceModalOpen(false)}>
              Fermer
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal
        open={issueOpen}
        onClose={() => !issueBusy && setIssueOpen(false)}
        title={isQuote ? "Émettre le devis" : "Émettre la facture"}
        description="Prévisualisez et modifiez l'email avant envoi. {{numero}} sera remplacé par le numéro définitif."
        wide
      >
        <div className="space-y-4">
          {!isQuote ? <PaymentLinkFields value={issuePayment} onChange={setIssuePayment} /> : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sendEmailOnIssue}
              disabled={!doc.client.email}
              onChange={(e) => setSendEmailOnIssue(e.target.checked)}
            />
            Envoyer par email au client
            {!doc.client.email ? (
              <span className="text-xs text-[var(--muted)]">(pas d&apos;adresse)</span>
            ) : (
              <span className="text-xs text-[var(--muted)]">({doc.client.email})</span>
            )}
          </label>

          {sendEmailOnIssue ? (
            <>
              <Field label="Objet">
                <Input
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  required
                />
              </Field>
              <Field label="Message">
                <Textarea
                  rows={14}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  required
                />
              </Field>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-4">
                <p className="mb-2 text-xs font-medium text-[var(--muted)]">Aperçu</p>
                <p className="mb-3 text-sm font-semibold">
                  {emailSubject.replaceAll("{{numero}}", "…")}
                </p>
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
                  {emailBody.replaceAll("{{numero}}", "…")}
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Pièce jointe : PDF du document
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Le document sera émis sans envoi d&apos;email.
            </p>
          )}

          <ModalActions>
            <Button
              type="button"
              variant="secondary"
              disabled={issueBusy}
              onClick={() => setIssueOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              disabled={
                issueBusy ||
                (!isQuote &&
                  (!paymentFieldsValid(issuePayment) ||
                    (issuePayment.mode === "manual" && !issuePayment.url.trim())))
              }
              onClick={() => void confirmIssue()}
            >
              {issueBusy
                ? "Émission…"
                : sendEmailOnIssue
                  ? "Émettre et envoyer"
                  : "Émettre sans email"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      {(() => {
        const draft = billing
          ? buildBillingEmailDraft({
              clientName: doc.client.displayName,
              kind: billing.kind,
              amountCents: billing.amountCents,
              quoteNumber: doc.number,
              companyName,
            })
          : { subject: "", body: "" };
        return (
          <BillingDialog
            open={billing !== null}
            title={billing?.kind === "SOLDE" ? "Facturer le solde" : `Facturer : ${billing?.kind === "ACOMPTE" ? billing.label : ""}`}
            description={
              billing?.kind === "SOLDE"
                ? "La facture de solde reprend le devis et déduit les acomptes réglés."
                : "Une fois cette facture payée, le projet du client est créé et démarre."
            }
            amountCents={billing?.amountCents ?? 0}
            clientEmail={doc.client.email}
            defaultSubject={draft.subject}
            defaultBody={draft.body}
            confirmLabel="Émettre la facture"
            busy={billingBusy}
            onConfirm={(req) => void confirmBilling(req)}
            onClose={() => setBilling(null)}
          />
        );
      })()}

      <Modal
        open={linkOpen}
        onClose={() => !linkBusy && setLinkOpen(false)}
        title="Lien de paiement"
        description={`Facture ${doc.number ?? ""} · reste dû ${formatEUR(remaining)}`}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void savePaymentLinkOnInvoice(paymentChoiceOf(linkPayment), linkSendEmail && linkPayment.mode !== "none");
          }}
        >
          <PaymentLinkFields
            value={linkPayment}
            onChange={setLinkPayment}
            noneLabel={doc.checkoutUrl ? "Retirer le lien (paiement par virement)" : "Pas de lien (virement)"}
          />
          {linkPayment.mode !== "none" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={linkSendEmail}
                disabled={!doc.client.email}
                onChange={(e) => setLinkSendEmail(e.target.checked)}
              />
              Renvoyer la facture au client avec ce lien
            </label>
          ) : null}
          <ModalActions>
            <Button variant="secondary" disabled={linkBusy} onClick={() => setLinkOpen(false)}>
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={
                linkBusy ||
                !paymentFieldsValid(linkPayment) ||
                (linkPayment.mode === "manual" && !linkPayment.url.trim())
              }
            >
              {linkBusy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Modifier le document" wide>
        <DocumentFormEditor
          mode="edit"
          documentType={kind}
          documentId={doc.id}
          clients={clients}
          initial={{
            clientId: doc.client.id,
            notes: doc.notes ?? "",
            paymentTerms: doc.paymentTerms ?? "",
            serviceDate: doc.serviceDate ? doc.serviceDate.slice(0, 10) : "",
            purchaseOrderRef: doc.purchaseOrderRef ?? "",
            sourceQuoteId: doc.sourceQuoteId ?? doc.quoteId ?? "",
            paymentPlanOffer:
              doc.paymentPlanOffer === "TWO" || doc.paymentPlanOffer === "THREE" || doc.paymentPlanOffer === "CHOICE"
                ? doc.paymentPlanOffer
                : "",
            validUntil: doc.validUntil ? doc.validUntil.slice(0, 10) : "",
            discountType:
              doc.discountType === "PERCENT" || doc.discountType === "FIXED"
                ? doc.discountType
                : "NONE",
            discountPercent:
              doc.discountType === "PERCENT"
                ? String((doc.discountValue ?? 0) / 100)
                : "",
            discountEuros:
              doc.discountType === "FIXED"
                ? String((doc.discountValue ?? 0) / 100)
                : "",
            lines: (doc.lines ?? []).map((l) => ({
              description: l.description,
              quantity: String(l.quantity),
              unitPriceEuros: String(l.unitPriceCents / 100),
              isSubscription: Boolean(l.isSubscription),
              billingDay: String(l.billingDay ?? 1),
              billingInterval: l.billingInterval === "YEAR" ? "YEAR" : "MONTH",
              serviceId: l.serviceId ?? "",
            })),
          }}
          onCancel={() => setEditOpen(false)}
          onSuccess={async () => {
            setEditOpen(false);
            await load();
          }}
        />
      </Modal>

      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title="Enregistrer un paiement"
        description="Saisissez le montant réellement encaissé."
      >
        <PaymentForm
          invoiceId={doc.id}
          defaultAmountEuros={(remaining / 100).toFixed(2)}
          onCancel={() => setPayOpen(false)}
          onSuccess={async () => {
            setPayOpen(false);
            await load();
          }}
        />
      </Modal>

      <CreditNoteWizard
        open={avoirOpen}
        invoiceId={doc.id}
        onClose={() => setAvoirOpen(false)}
        onCreated={() => void load()}
      />

      <Modal
        open={rejectOpen}
        onClose={() => !rejectBusy && setRejectOpen(false)}
        title="Refus du devis"
        description="Le devis sera clos et ne pourra plus être facturé."
      >
        <div className="space-y-4">
          <Field label="Motif (facultatif)">
            <Textarea
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Budget trop élevé, projet reporté, concurrent retenu…"
            />
          </Field>
          <ModalActions>
            <Button
              type="button"
              variant="secondary"
              disabled={rejectBusy}
              onClick={() => setRejectOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={rejectBusy}
              onClick={() => void reject()}
            >
              {rejectBusy ? "…" : "Enregistrer le refus"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <ConfirmDialog
        open={forceSoldeMessage !== null}
        title="Générer le solde quand même ?"
        message={`${forceSoldeMessage ?? ""} Vous pouvez passer outre et émettre la facture de solde.`}
        confirmLabel="Émettre le solde"
        danger
        busy={billingBusy}
        onConfirm={() => {
          setForceSoldeMessage(null);
          generateSolde(true);
        }}
        onClose={() => setForceSoldeMessage(null)}
      />
    </div>
  );
}
