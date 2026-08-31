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
import { Button } from "@/components/ui/Button";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { DataTable, type TableColumn } from "@/components/ui/DataTable";
import { DocumentFormEditor } from "@/components/documents/DocumentForm";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { InvoiceTypeBadge } from "@/components/documents/InvoiceTypeBadge";
import { MarketTimeline, type MarketView } from "@/components/documents/MarketTimeline";
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

  const docColumns: TableColumn<Doc>[] = [
    {
      name: "Numéro",
      selector: (d) => d.number ?? "",
      sortable: true,
      grow: 2,
      cell: (d) => (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DocumentNumberBadge
            number={d.number}
            documentType={d.documentType}
            invoiceType={d.invoiceType}
          />
          <InvoiceTypeBadge type={d.invoiceType} />
          {!isQuote && (d.quote?.number || d.quoteId) ? (
            <Link
              to={`/quotes/${d.quoteId ?? d.quote?.id}`}
              className="text-xs text-[var(--muted)] hover:text-[var(--primary)]"
              onClick={(e) => e.stopPropagation()}
            >
              Projet {d.quote?.number ?? ""}
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      name: "Client",
      selector: (d) => d.client.displayName,
      sortable: true,
      grow: 2,
      cell: (d) => (
        <span className="block truncate" title={d.client.displayName}>
          {d.client.displayName}
        </span>
      ),
    },
    {
      name: "Statut",
      selector: (d) => displayStatus(d, isQuote),
      sortable: true,
      width: "130px",
      cell: (d) => {
        const st = displayStatus(d, isQuote);
        return <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>;
      },
    },
    {
      name: "Date",
      selector: (d) => d.issueDate ?? "",
      sortable: true,
      width: "130px",
      cell: (d) => (
        <span className="text-[var(--muted)]">{formatDate(d.issueDate)}</span>
      ),
    },
    {
      name: "Total HT",
      selector: (d) => d.totalCents,
      sortable: true,
      width: "140px",
      right: true,
      cell: (d) => (
        <span className="tabular-nums">{formatEUR(d.totalCents)}</span>
      ),
    },
    {
      name: "",
      grow: 0,
      width: "5.5rem",
      right: true,
      style: { whiteSpace: "nowrap" },
      cell: (d) => (
        <Button
          variant="ghost"
          className="h-8 px-3 text-xs"
          onClick={() => navigate(isQuote ? `/quotes/${d.id}` : `/invoices/${d.id}`)}
        >
          Ouvrir
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={isQuote ? "Devis" : "Factures"}
        subtitle={
          isQuote
            ? "Ce que j'ai proposé, et ce qui a été accepté"
            : "Ce que j'ai facturé, et ce qui a été payé"
        }
        actions={
          <Button onClick={openCreate}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
            {isQuote ? "Nouveau devis" : "Nouvelle facture"}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {filters.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              statusFilter === s
                ? "bg-[var(--primary)] text-white"
                : "bg-[var(--surface)] text-[var(--muted)] ring-1 ring-[var(--border)] hover:text-[var(--text)]"
            }`}
          >
            {s === "ALL" ? "Tous" : labels[s] ?? s}
          </button>
        ))}
      </div>

      {loading ? (
        <Card>
          <p className="p-8 text-sm text-[var(--muted)]">Chargement…</p>
        </Card>
      ) : (
        <DataTable
          columns={docColumns}
          data={filtered}
          pagination
          perPage={25}
          searchable={["number", "client.displayName", "client.clientNumber"]}
          searchPlaceholder={isQuote ? "Rechercher un devis…" : "Rechercher une facture…"}
          emptyTitle={isQuote ? "Aucun devis" : "Aucune facture"}
          emptyHint="Créez un document pour démarrer le suivi."
        />
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
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [sendEmailOnIssue, setSendEmailOnIssue] = useState(true);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [companyName, setCompanyName] = useState("Alexandre Kouziaeff");
  const [forceSoldeMessage, setForceSoldeMessage] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);

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

  async function convert() {
    try {
      const inv = await api<{ id: string; subscriptionsCreated?: number }>(
        `/api/invoices/${id}/convert`,
        {
          method: "POST",
          body: "{}",
        },
      );
      toast.success("Facture créée depuis le devis");
      if (inv.subscriptionsCreated && inv.subscriptionsCreated > 0) {
        toast.success(
          `${inv.subscriptionsCreated} abonnement(s) créé(s) (prochaine facture le mois suivant)`,
        );
      }
      navigate(`/invoices/${inv.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
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
        subtitle={`${doc.client.displayName} · ${labels[st] ?? st}${
          doc.invoiceType && doc.invoiceType !== "SIMPLE"
            ? ` · ${doc.invoiceType === "ACOMPTE" ? "Acompte" : "Solde"}`
            : ""
        }`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => navigate(isQuote ? "/quotes" : "/invoices")}
            >
              Retour
            </Button>
            {doc.status === "DRAFT" ? (
              <>
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  Modifier
                </Button>
                <Button onClick={() => openIssueModal()}>
                  {isQuote ? "Émettre" : "Émettre"}
                </Button>
              </>
            ) : null}
            {doc.number ? (
              <a
                href={`/api/invoices/${doc.id}/pdf`}
                className="inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-sm font-medium hover:bg-[var(--surface-raised)]"
              >
                PDF
              </a>
            ) : null}
            {!isQuote && doc.status === "ISSUED" ? (
              <Button onClick={() => setPayOpen(true)}>Paiement</Button>
            ) : null}
            {!isQuote &&
            doc.documentType === "INVOICE" &&
            (doc.status === "ISSUED" || doc.status === "PAID") ? (
              <Button variant="danger" onClick={() => setAvoirOpen(true)}>
                Avoir
              </Button>
            ) : null}
            {isQuote &&
            (doc.quoteStatus === "SENT" ||
              doc.status === "ISSUED" ||
              doc.status === "DRAFT") ? (
              <Button variant="secondary" onClick={() => void convert()}>
                Valider et facturer
              </Button>
            ) : null}
            {isQuote && doc.quoteStatus === "SENT" ? (
              <Button variant="ghost" onClick={() => setRejectOpen(true)}>
                Refusé par le client
              </Button>
            ) : null}
            {doc.number ? (
              <Button variant="ghost" onClick={() => void sendReminder()}>
                Relancer
              </Button>
            ) : null}
          </>
        }
      />

      {isQuote && market ? (
        <MarketTimeline
          market={market}
          busyId={busyId}
          onGenerateAcompte={(mid) => void generateDeposit(mid)}
          onGenerateSolde={(force) => void generateSolde(Boolean(force))}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">Lignes</h2>
          <table className="w-full text-sm">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="pb-2 text-left font-medium">Description</th>
                <th className="pb-2 text-right font-medium">Qté</th>
                <th className="pb-2 text-right font-medium">P.U. HT</th>
                <th className="pb-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {(doc.lines ?? []).map((l, i) => (
                <tr key={i} className="border-t border-[var(--border)]">
                  <td className="py-2.5 pr-4">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{l.description}</span>
                        {l.isSubscription ? (
                          <Badge tone="amber">Abonnement mensuel</Badge>
                        ) : null}
                      </div>
                      {l.isSubscription ? (
                        <p className="max-w-xl text-xs leading-relaxed text-[var(--muted)]">
                          Facturation le {l.billingDay ?? "…"} de chaque mois
                          {" : "}
                          {formatEUR(l.unitPriceCents)} HT.
                          {" "}
                          Ce document inclut la 1re échéance.
                        </p>
                      ) : null}
                    </div>
                  </td>
                  <td className="w-16 py-2.5 text-right tabular-nums">{String(l.quantity)}</td>
                  <td className="w-28 py-2.5 text-right tabular-nums">
                    {formatEUR(l.unitPriceCents)}
                  </td>
                  <td className="w-28 py-2.5 text-right tabular-nums font-medium">
                    {formatEUR(l.lineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                      {formatEUR(l.unitPriceCents)} HT facturés chaque mois
                      {l.billingDay ? ` le ${l.billingDay}` : ""}.
                      {" "}
                      Les mois suivants seront facturés automatiquement.
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
          <div className="flex justify-end border-t border-[var(--border)] pt-3 text-sm">
            <div className="space-y-1 text-right">
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
              <p className="text-[var(--muted)]">Total HT</p>
              <p className="text-xl font-semibold tabular-nums">{formatEUR(doc.totalCents)}</p>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="space-y-3 p-5 text-sm">
            <h2 className="font-semibold">Informations</h2>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--muted)]">Statut</span>
              <Badge tone={statusTone(st)}>{labels[st]}</Badge>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-[var(--muted)]">Client</span>
              <Link to={`/clients/${doc.client.id}`} className="link truncate">
                {doc.client.displayName}
              </Link>
            </div>
            {doc.client.email ? (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--muted)]">Email</span>
                <ClientEmailLink
                  email={doc.client.email}
                  name={doc.client.displayName}
                  clientId={doc.client.id}
                  defaultSubject={`${isQuote ? "Devis" : "Facture"} ${doc.number ?? ""}`}
                  defaultTemplate={isQuote ? "quote_followup" : "invoice_reminder"}
                />
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <span className="text-[var(--muted)]">Date</span>
              <span>{formatDate(doc.issueDate)}</span>
            </div>
            {isQuote ? (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--muted)]">Valable jusqu&apos;au</span>
                <span>{formatDate(doc.validUntil)}</span>
              </div>
            ) : null}
            {isQuote && doc.quoteDecidedAt ? (
              <div className="border-t border-[var(--border)] pt-3">
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
            {!isQuote && doc.quoteId ? (
              <div className="flex justify-between gap-2 border-t border-[var(--border)] pt-3">
                <span className="text-[var(--muted)]">Projet</span>
                <Link to={`/quotes/${doc.quoteId}`} className="link">
                  {doc.quote?.number ?? "Devis"}
                </Link>
              </div>
            ) : null}
            {!isQuote && linked.length > 0 ? (
              <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
                <p className="text-[var(--muted)]">Autres factures</p>
                {linked.map((s) => (
                  <Link key={s.id} to={`/invoices/${s.id}`} className="link-row text-xs">
                    <span className="font-mono">{s.number ?? "…"}</span>
                    <span className="link-row-muted tabular-nums">
                      {formatEUR(s.totalCents)}
                    </span>
                  </Link>
                ))}
              </div>
            ) : null}
            {doc.paymentTerms ? (
              <div className="border-t border-[var(--border)] pt-3">
                <p className="text-[var(--muted)]">Conditions</p>
                <p className="mt-0.5">{doc.paymentTerms}</p>
              </div>
            ) : null}
            {doc.notes ? (
              <div>
                <p className="text-[var(--muted)]">Notes</p>
                <p className="mt-0.5 whitespace-pre-wrap">{doc.notes}</p>
              </div>
            ) : null}
          </Card>

          {!isQuote ? (
            <Card className="space-y-3 p-5 text-sm">
              <h2 className="font-semibold">Encaissements</h2>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Payé</span>
                <span className="tabular-nums font-medium text-[var(--success)]">
                  {formatEUR(paid)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Reste dû</span>
                <span className="tabular-nums font-medium">{formatEUR(remaining)}</span>
              </div>
              {(doc.payments ?? []).length === 0 ? (
                <p className="text-[var(--muted)]">Aucun paiement.</p>
              ) : (
                <ul className="space-y-2 border-t border-[var(--border)] pt-3">
                  {(doc.payments ?? []).map((p) => (
                    <li key={p.id} className="flex justify-between gap-2">
                      <span>{formatDate(p.paidAt)}</span>
                      <span className="tabular-nums">{formatEUR(p.amountCents)}</span>
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
        </div>
      </div>

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

          <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
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
          </div>
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
          <div className="flex justify-end gap-2">
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
          </div>
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
