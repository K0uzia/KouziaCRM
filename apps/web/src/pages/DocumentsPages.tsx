import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import {
  formatDate,
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
import { DataTable, type TableColumn } from "@/components/ui/DataTable";
import { Media } from "react-data-table-component";
import { DocumentFormEditor } from "@/components/documents/DocumentForm";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { InvoiceTypeBadge } from "@/components/documents/InvoiceTypeBadge";
import { MarketTimeline, type MarketView } from "@/components/documents/MarketTimeline";
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
import { buildIssueEmailDraft } from "@/lib/issue-email";
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
    serviceId?: string | null;
  }>;
  milestones?: Milestone[];
};

type ClientOpt = { id: string; displayName: string; clientNumber?: string | null };

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
  const [statusFilter, setStatusFilter] = useState("ALL");
  const openCreate = useCallback(() => setCreateOpen(true), []);

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
          <DocumentNumberBadge
            number={d.number}
            documentType={d.documentType}
            invoiceType={d.invoiceType}
          />
          <span className="font-semibold tabular-nums">{formatEUR(d.totalCents)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm">{d.client.displayName}</span>
          <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">{formatDate(d.issueDate)}</p>
      </Link>
    );
  };

  const detailPath = (d: Doc) => (isQuote ? `/quotes/${d.id}` : `/invoices/${d.id}`);

  const docColumns: TableColumn<Doc>[] = [
    {
      name: "Numéro",
      selector: (d) => d.number ?? "",
      sortable: true,
      grow: 2,
      cell: (d) => (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link to={detailPath(d)} className="rounded-[var(--radius-sm)] hover:opacity-80">
            <DocumentNumberBadge number={d.number} documentType={d.documentType} invoiceType={d.invoiceType} />
          </Link>
          <InvoiceTypeBadge type={d.invoiceType} />
          {!isQuote && (d.quote?.number || d.quoteId) ? (
            <Link
              to={`/quotes/${d.quoteId ?? d.quote?.id}`}
              className="text-xs text-[var(--muted)] hover:text-[var(--primary)]"
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
          <p className="truncate font-medium" title={d.client.displayName}>
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
        return <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>;
      },
    },
    {
      name: "Émis le",
      selector: (d) => d.issueDate ?? "",
      sortable: true,
      width: "8.5rem",
      cell: (d) => <span className="text-[var(--muted)]">{d.issueDate ? formatDate(d.issueDate) : "Brouillon"}</span>,
    },
    ...((isQuote
      ? [
          {
            name: "Valable jusqu'au",
            selector: (d: Doc) => d.validUntil ?? "",
            sortable: true,
            width: "9.5rem",
            hide: Media.LG,
            cell: (d: Doc) => <span className="text-[var(--muted)]">{d.validUntil ? formatDate(d.validUntil) : "-"}</span>,
          },
        ]
      : []) as TableColumn<Doc>[]),
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
          <Button onClick={openCreate}>
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
  const [rejectReason, setRejectReason] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [invoiceModalBusy, setInvoiceModalBusy] = useState(false);

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
  const canCreateInvoice =
    isQuote &&
    Boolean(doc.number) &&
    (doc.quoteStatus === "ACCEPTED" || doc.quoteStatus === "SENT");
  const totalInvoiceDisabled = hasSimpleInvoice || hasDepositInvoices;

  function openIssueModal() {
    const draft = buildIssueEmailDraft(doc!, kind, companyName);
    setEmailSubject(draft.subject);
    setEmailBody(draft.body);
    setSendEmailOnIssue(Boolean(doc!.client.email));
    setIssueOpen(true);
  }

  async function confirmIssue() {
    setIssueBusy(true);
    try {
      const res = await api<{
        emailed?: boolean;
        emailReason?: string | null;
        subscriptionsCreated?: number;
      }>(`/api/invoices/${id}/issue`, {
        method: "POST",
        body: JSON.stringify({
          email: {
            send: sendEmailOnIssue,
            subject: emailSubject,
            body: emailBody,
          },
        }),
      });
      setIssueOpen(false);
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

  async function createMilestoneInvoice(milestoneId: string) {
    setInvoiceModalBusy(true);
    try {
      const inv = await api<{ id: string }>(
        `/api/quotes/${id}/milestones/${milestoneId}/invoice`,
        { method: "POST", body: "{}" },
      );
      toast.success("Facture d'acompte créée");
      setInvoiceModalOpen(false);
      navigate(`/invoices/${inv.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setInvoiceModalBusy(false);
    }
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
      toast.success("Acompte marqué comme payé");
      setPayingMilestoneId(null);
      await load();
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

  async function generateDeposit(milestoneId: string) {
    setBusyId(milestoneId);
    try {
      const inv = await api<{ id: string }>(
        `/api/quotes/${id}/milestones/${milestoneId}/invoice`,
        { method: "POST", body: "{}" },
      );
      toast.success("Facture d'acompte émise");
      navigate(`/invoices/${inv.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusyId(null);
    }
  }

  async function generateSolde(force = false) {
    setBusyId("solde");
    try {
      const res = await api<{ invoice: { id: string } }>(
        `/api/quotes/${id}/balance-invoice`,
        { method: "POST", body: JSON.stringify({ force }) },
      );
      toast.success("Facture de solde émise");
      navigate(`/invoices/${res.invoice.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erreur";
      if (!force && msg.includes("force=true")) {
        setForceSoldeMessage(msg);
        return;
      }
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
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
            <Link to={`/clients/${doc.client.id}`} className="link">
              {doc.client.displayName}
            </Link>
            <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
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
                className="mt-1 inline-flex flex-wrap items-center gap-2 font-medium hover:text-[var(--primary)]"
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
                  <tr className="bg-[var(--bg-subtle)] text-[0.6875rem] uppercase tracking-[0.06em] text-[var(--muted)]">
                    <th className="px-5 py-2.5 text-left font-semibold sm:px-6">Désignation</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Qté</th>
                    <th className="px-3 py-2.5 text-right font-semibold">P.U. TTC</th>
                    <th className="px-5 py-2.5 text-right font-semibold sm:px-6">Total TTC</th>
                  </tr>
                </thead>
                <tbody>
                  {(doc.lines ?? []).map((l, i) => (
                    <tr key={i} className="border-t border-[var(--border)]">
                      <td className="px-5 py-3 sm:px-6" data-label="Désignation">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{l.description}</span>
                          {l.isSubscription ? <Badge tone="amber">Mensuel</Badge> : null}
                        </div>
                        {l.isSubscription ? (
                          <p className="mt-1 max-w-xl text-xs text-[var(--muted)]">
                            Facturé le {l.billingDay ?? "…"} de chaque mois. Ce document inclut la 1re échéance.
                          </p>
                        ) : null}
                      </td>
                      <td className="w-16 px-3 py-3 text-right tabular-nums" data-label="Qté">
                        {String(l.quantity)}
                      </td>
                      <td className="w-28 px-3 py-3 text-right tabular-nums" data-label="P.U. TTC">
                        {formatEUR(l.unitPriceCents)}
                      </td>
                      <td className="w-32 px-5 py-3 text-right font-medium tabular-nums sm:px-6" data-label="Total TTC">
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
                  <p className="font-medium">Récurrence mensuelle</p>
                  <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[var(--muted)]">
                    {(doc.lines ?? [])
                      .filter((l) => l.isSubscription)
                      .map((l, i) => (
                        <li key={i}>
                          <span className="text-[var(--text)]">{l.description}</span>
                          {" : "}
                          {formatEUR(l.unitPriceCents)} TTC facturés chaque mois
                          {l.billingDay ? ` le ${l.billingDay}` : ""}.
                          {" "}
                          Les mois suivants seront facturés automatiquement.
                        </li>
                      ))}
                  </ul>
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
                        ? ` (${((doc.discountValue ?? 0) / 100).toFixed(2)} %)`
                        : ""}
                      : −
                      {formatEUR(
                        Math.max(0, (doc.subtotalCents ?? doc.totalCents) - doc.totalCents),
                      )}
                    </p>
                  </>
                ) : null}
                <div className="flex items-baseline justify-between border-t border-[var(--border)] pt-2">
                  <span className="font-medium">Total TTC</span>
                  <span className="font-display text-2xl font-semibold tabular-nums">{formatEUR(doc.totalCents)}</span>
                </div>
              </div>
            </div>
          </Card>

          {isQuote && market ? (
            <MarketTimeline
              market={market}
              busyId={busyId}
              onGenerateAcompte={(mid) => void generateDeposit(mid)}
              onGenerateSolde={(force) => void generateSolde(Boolean(force))}
              onManualPay={(mid) => setPayingMilestoneId(mid)}
              onSavePaymentLink={(mid, url, send) => savePaymentLink(mid, url, send)}
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
                      <Link to={`/invoices/${inv.id}`} className="font-medium hover:text-[var(--primary)]">
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

          {isQuote && doc.number ? (
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

          {!isQuote && (doc.quoteId || linked.length > 0) ? (
            <Card className="space-y-2 p-5 text-sm">
              <h2 className="mb-1 text-sm font-semibold">Documents liés</h2>
              {doc.quoteId ? (
                <Link to={`/quotes/${doc.quoteId}`} className="link-row">
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
        open={invoiceModalOpen}
        onClose={() => !invoiceModalBusy && setInvoiceModalOpen(false)}
        title="Créer une facture"
        description={
          doc.quoteStatus === "ACCEPTED"
            ? "Devis validé : facturez l'acompte. Le projet du client est créé avec cette facture et démarre à son paiement."
            : "Le devis n'est pas encore validé par le client : vous pouvez tout de même préparer la facture."
        }
      >
        <div className="space-y-4">
          {hasMarket ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Échéancier du devis</p>
              {market!.milestones.map((m, idx) => {
                const isFirst = idx === 0;
                const already = Boolean(m.invoiceId);
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={invoiceModalBusy || already}
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
                          : isFirst
                            ? "Étape suivante : crée le projet client"
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
                    : "Pour une petite prestation réglée en une fois. Le projet est aussi créé."}
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
            <Button type="button" disabled={issueBusy} onClick={() => void confirmIssue()}>
              {issueBusy
                ? "Émission…"
                : sendEmailOnIssue
                  ? "Émettre et envoyer"
                  : "Émettre sans email"}
            </Button>
          </ModalActions>
        </div>
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
        busy={busyId === "solde"}
        onConfirm={() => {
          setForceSoldeMessage(null);
          void generateSolde(true);
        }}
        onClose={() => setForceSoldeMessage(null)}
      />
    </div>
  );
}
