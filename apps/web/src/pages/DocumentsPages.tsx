import { useEffect, useMemo, useState } from "react";
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
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { DocumentFormEditor } from "@/components/documents/DocumentForm";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { InvoiceTypeBadge } from "@/components/documents/InvoiceTypeBadge";
import { MarketTimeline, type MarketView } from "@/components/documents/MarketTimeline";
import { PaymentForm } from "@/components/payments/PaymentForm";
import { ClientEmailLink } from "@/components/clients/ClientEmailLink";

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
  documentType: string;
  invoiceType?: string;
  quoteId?: string | null;
  quote?: { id: string; number: string | null } | null;
  totalCents: number;
  issueDate: string | null;
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
  lines?: Array<{
    description: string;
    quantity: number | string;
    unitPriceCents: number;
    lineTotalCents: number;
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

  return (
    <div>
      <PageHeader
        title={isQuote ? "Devis" : "Factures"}
        subtitle={
          isQuote
            ? "Propositions commerciales - émission puis conversion en facture"
            : "Documents émis, encaissements et avoirs"
        }
        actions={
          <Button onClick={() => setCreateOpen(true)}>
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
                : "bg-white text-[var(--muted)] ring-1 ring-[var(--border)] hover:text-[var(--text)]"
            }`}
          >
            {s === "ALL" ? "Tous" : labels[s] ?? s}
          </button>
        ))}
      </div>

      <Card className="overflow-x-auto">
        {loading ? (
          <p className="p-8 text-sm text-[var(--muted)]">Chargement…</p>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={isQuote ? "Aucun devis" : "Aucune facture"}
            hint="Créez un document pour démarrer le suivi."
          />
        ) : (
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="border-b border-[var(--border)] text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Numéro</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Statut</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Date</th>
                <th className="px-4 py-3 text-right font-medium">Total HT</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => {
                const st = displayStatus(d, isQuote);
                return (
                  <tr
                    key={d.id}
                    className="cursor-pointer border-t border-[var(--border)] hover:bg-[var(--bg)]/60"
                    onClick={() =>
                      navigate(isQuote ? `/quotes/${d.id}` : `/invoices/${d.id}`)
                    }
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <DocumentNumberBadge
                          number={d.number}
                          documentType={d.documentType}
                          invoiceType={d.invoiceType}
                        />
                        <InvoiceTypeBadge type={d.invoiceType} />
                      </div>
                      {!isQuote && (d.quote?.number || d.quoteId) ? (
                        <Link
                          to={`/quotes/${d.quoteId ?? d.quote?.id}`}
                          className="mt-0.5 block text-xs text-[var(--muted)] hover:text-[var(--primary)]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Marché {d.quote?.number ?? ""}
                        </Link>
                      ) : null}
                    </td>
                    <td className="max-w-[12rem] truncate px-4 py-3">
                      {d.client.displayName}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(st)}>{labels[st] ?? st}</Badge>
                    </td>
                    <td className="hidden px-4 py-3 text-[var(--muted)] md:table-cell">
                      {formatDate(d.issueDate)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatEUR(d.totalCents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

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
  const [market, setMarket] = useState<MarketView | null>(null);
  const [linked, setLinked] = useState<Doc[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

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
  }, [id]);

  if (!doc) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  const st = displayStatus(doc, isQuote);
  const labels = isQuote ? quoteStatusLabel : invoiceStatusLabel;
  const paid = (doc.payments ?? []).reduce((s, p) => s + p.amountCents, 0);
  const remaining = Math.max(0, doc.totalCents - paid);

  async function issue() {
    try {
      await api(`/api/invoices/${id}/issue`, { method: "POST", body: "{}" });
      toast.success(isQuote ? "Devis émis" : "Facture émise");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  async function convert() {
    try {
      const inv = await api<{ id: string }>(`/api/invoices/${id}/convert`, {
        method: "POST",
        body: "{}",
      });
      toast.success("Facture créée depuis le devis");
      navigate(`/invoices/${inv.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  async function cancel() {
    if (!confirm("Créer un avoir et annuler cette facture ?")) return;
    try {
      await api(`/api/invoices/${id}/cancel`, { method: "POST", body: "{}" });
      toast.success("Avoir créé");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
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
        if (confirm(`${msg}\n\nForcer la génération du solde ?`)) {
          await generateSolde(true);
          return;
        }
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
                <Button onClick={() => void issue()}>
                  {isQuote ? "Émettre" : "Émettre"}
                </Button>
              </>
            ) : null}
            {doc.number ? (
              <a
                href={`/api/invoices/${doc.id}/pdf`}
                className="inline-flex h-10 items-center rounded-[var(--radius)] border border-[var(--border-strong)] bg-white px-4 text-sm font-medium"
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
              <Button variant="danger" onClick={() => void cancel()}>
                Avoir
              </Button>
            ) : null}
            {isQuote &&
            (doc.quoteStatus === "SENT" ||
              doc.status === "ISSUED" ||
              doc.status === "DRAFT") ? (
              <Button variant="secondary" onClick={() => void convert()}>
                Convertir
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
                  <td className="py-2.5">{l.description}</td>
                  <td className="py-2.5 text-right tabular-nums">{String(l.quantity)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatEUR(l.unitPriceCents)}</td>
                  <td className="py-2.5 text-right tabular-nums font-medium">
                    {formatEUR(l.lineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end border-t border-[var(--border)] pt-3 text-sm">
            <div className="text-right">
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
              <Link
                to={`/clients/${doc.client.id}`}
                className="truncate text-[var(--primary)] hover:underline"
              >
                {doc.client.displayName}
              </Link>
            </div>
            {doc.client.email ? (
              <div className="flex justify-between gap-2">
                <span className="text-[var(--muted)]">Email</span>
                <ClientEmailLink
                  email={doc.client.email}
                  name={doc.client.displayName}
                  defaultSubject={`${isQuote ? "Devis" : "Facture"} ${doc.number ?? ""}`}
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
            {!isQuote && doc.quoteId ? (
              <div className="flex justify-between gap-2 border-t border-[var(--border)] pt-3">
                <span className="text-[var(--muted)]">Marché</span>
                <Link
                  to={`/quotes/${doc.quoteId}`}
                  className="text-[var(--primary)] hover:underline"
                >
                  {doc.quote?.number ?? "Devis"}
                </Link>
              </div>
            ) : null}
            {!isQuote && linked.length > 0 ? (
              <div className="space-y-1.5 border-t border-[var(--border)] pt-3">
                <p className="text-[var(--muted)]">Autres factures</p>
                {linked.map((s) => (
                  <Link
                    key={s.id}
                    to={`/invoices/${s.id}`}
                    className="flex justify-between gap-2 hover:text-[var(--primary)]"
                  >
                    <span className="font-mono text-xs">{s.number ?? "…"}</span>
                    <span className="tabular-nums text-xs text-[var(--muted)]">
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
            </Card>
          ) : null}
        </div>
      </div>

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
            validUntil: doc.validUntil ? doc.validUntil.slice(0, 10) : "",
            lines: (doc.lines ?? []).map((l) => ({
              description: l.description,
              quantity: String(l.quantity),
              unitPriceEuros: String(l.unitPriceCents / 100),
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
    </div>
  );
}
