import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Badge, Card } from "@/components/ui/Card";
import { formatDate, formatEUR, statusLabel, quoteStatusLabel, invoiceStatusLabel, statusTone, paymentMethodLabel } from "@/lib/format";

type TrackingPayment = {
  paidAt: string;
  method: string;
  amountCents?: number;
};

type TrackingDoc = {
  id: string;
  number: string | null;
  documentType: string;
  status: string;
  quoteStatus?: string | null;
  issueDate: string | null;
  validUntil: string | null;
  dueDate: string | null;
  downloadToken?: string | null;
  totalCents?: number;
  subtotalCents?: number;
  paidCents?: number;
  remainingCents?: number;
  payments?: TrackingPayment[];
  milestones?: Array<{
    label: string;
    percentBps: number;
    status: string;
    triggerText?: string;
    amountCents?: number;
  }>;
};

type TrackingSub = {
  label: string;
  billingDay: number;
  nextInvoiceAt: string;
  amountCents?: number;
};

type CompanyContact = {
  tradeName: string;
  legalName?: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  country: string;
};

type TrackingResult = {
  clientFirstName?: string;
  clientNumber?: string | null;
  displayName?: string;
  company?: CompanyContact;
  documents: TrackingDoc[];
  subscriptions?: TrackingSub[];
};

type Tab = "paid" | "ongoing" | "upcoming";

const STORAGE_KEY = "kouzia_tracking_creds";

// Libellés côté client (le client "reçoit", il ne "reçoit pas envoyé").
const quoteStatusLabelClient: Record<string, string> = {
  DRAFT: "Reçu",
  SENT: "Reçu, en attente de votre réponse",
  ACCEPTED: "Accepté",
  REJECTED: "Refusé",
  EXPIRED: "Expiré",
  ISSUED: "Reçu, en attente de votre réponse",
  PAID: "Accepté",
  CANCELLED: "Refusé / annulé",
};
const invoiceStatusLabelClient: Record<string, string> = {
  DRAFT: "Reçue",
  ISSUED: "Reçue, en attente de règlement",
  PAID: "Payée",
  CANCELLED: "Annulée",
};

type StoredCreds = { clientNumber: string; accessCode: string };

function readCreds(): StoredCreds | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCreds>;
    if (parsed.clientNumber && parsed.accessCode) return parsed as StoredCreds;
    return null;
  } catch {
    return null;
  }
}

function writeCreds(c: StoredCreds) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* sessionStorage indisponible (mode privé) : on continue sans persistance */
  }
}

function clearCreds() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function TrackingPage() {
  const [clientNumber, setClientNumber] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<TrackingResult | null>(null);

  async function authenticate(cn: string, code: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/public/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNumber: cn, accessCode: code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Accès refusé");
      }
      setData(body as TrackingResult);
      writeCreds({ clientNumber: cn, accessCode: code });
      return true;
    } catch (err) {
      setData(null);
      clearCreds();
      setError(err instanceof Error ? err.message : "Erreur");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await authenticate(clientNumber.trim().toUpperCase(), accessCode);
  }

  // Reconnexion silencieuse après un refresh si des identifiants sont mémorisés.
  useEffect(() => {
    const saved = readCreds();
    if (saved && !data) {
      void authenticate(saved.clientNumber, saved.accessCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLogout() {
    clearCreds();
    setData(null);
    setClientNumber("");
    setAccessCode("");
  }

  if (!data) {
    return (
      <Shell>
        <p className="text-2xl font-semibold tracking-tight text-[var(--primary)]">Kouzia</p>
        <h1 className="mt-2 text-xl font-semibold">Suivi de projet</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Identifiez-vous avec votre code de suivi client et votre code d&apos;accès.
        </p>

        <form
          onSubmit={onSubmit}
          className="mt-8 space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-white p-5 shadow-[var(--shadow)]"
        >
          <Field label="Code de suivi" hint="Votre identifiant unique CLI-xxxx">
            <Input
              required
              placeholder="CLI-0001"
              value={clientNumber}
              onChange={(e) => setClientNumber(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Code d'accès" hint="Code secret fourni à la création du dossier">
            <Input
              required
              type="password"
              autoComplete="off"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
            />
          </Field>
          {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Vérification..." : "Accéder"}
          </Button>
        </form>
      </Shell>
    );
  }

  return <TrackingDashboard data={data} onLogout={handleLogout} />;
}

function TrackingDashboard({ data, onLogout }: { data: TrackingResult; onLogout: () => void }) {
  const company = data.company;
  const docs = data.documents ?? [];
  const subs = data.subscriptions ?? [];

  // "Réglés" : encaissements réglés + avoirs + devis refusés/expirés (décisions closes).
  const paid = useMemo(
    () =>
      docs.filter((d) => {
        if (d.documentType === "QUOTE") {
          return d.quoteStatus === "REJECTED" || d.quoteStatus === "EXPIRED";
        }
        return d.status === "PAID" || d.documentType === "CREDIT_NOTE";
      }),
    [docs],
  );
  // "En cours" : factures émises en attente de règlement + devis acceptés (facture à venir).
  const ongoing = useMemo(
    () =>
      docs.filter((d) => {
        if (d.documentType === "INVOICE") return d.status === "ISSUED";
        if (d.documentType === "QUOTE") return d.quoteStatus === "ACCEPTED";
        return false;
      }),
    [docs],
  );
  // "À venir" : devis envoyés en attente de réponse client (+ abonnements).
  const upcomingQuotes = useMemo(
    () => docs.filter((d) => d.documentType === "QUOTE" && d.quoteStatus === "SENT"),
    [docs],
  );

  const defaultTab: Tab = ongoing.length > 0 ? "ongoing" : paid.length > 0 ? "paid" : "upcoming";
  const [tab, setTab] = useState<Tab>(defaultTab);

  return (
    <Shell wide>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-[var(--primary)]">Kouzia</p>
          <h1 className="mt-1 text-xl font-semibold">
            Bonjour{data.clientFirstName ? `, ${data.clientFirstName}` : ""}
          </h1>
          {data.clientNumber ? (
            <p className="mt-0.5 font-mono text-xs text-[var(--muted)]">{data.clientNumber}</p>
          ) : null}
        </div>
        <Button variant="secondary" onClick={onLogout}>
          Déconnexion
        </Button>
      </div>

      {company ? <ContactCard company={company} /> : null}

      <div className="mt-6 flex gap-1 rounded-[var(--radius)] bg-[var(--bg)] p-1">
        <TabButton active={tab === "paid"} onClick={() => setTab("paid")} count={paid.length}>
          Réglés
        </TabButton>
        <TabButton active={tab === "ongoing"} onClick={() => setTab("ongoing")} count={ongoing.length}>
          En cours
        </TabButton>
        <TabButton
          active={tab === "upcoming"}
          onClick={() => setTab("upcoming")}
          count={upcomingQuotes.length + subs.length}
        >
          À venir
        </TabButton>
      </div>

      <div className="mt-4 space-y-3">
        {tab === "paid" ? (
          paid.length === 0 ? (
            <Empty>Aucun paiement réglé pour le moment.</Empty>
          ) : (
            paid.map((d) => <DocCard key={d.id} doc={d} kind="paid" />)
          )
        ) : null}

        {tab === "ongoing" ? (
          ongoing.length === 0 ? (
            <Empty>Aucune facture en attente de règlement.</Empty>
          ) : (
            ongoing.map((d) => <DocCard key={d.id} doc={d} kind="ongoing" />)
          )
        ) : null}

        {tab === "upcoming" ? (
          <>
            {upcomingQuotes.length === 0 && subs.length === 0 ? (
              <Empty>Aucun devis ni échéance à venir.</Empty>
            ) : null}
            {upcomingQuotes.map((d) => (
              <DocCard key={d.id} doc={d} kind="quote" />
            ))}
            {subs.map((s, i) => (
              <SubCard key={i} sub={s} />
            ))}
          </>
        ) : null}
      </div>
    </Shell>
  );
}

function ContactCard({ company }: { company: CompanyContact }) {
  const address = [
    company.addressLine1,
    company.addressLine2,
    [company.postalCode, company.city].filter(Boolean).join(" "),
    company.country,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Card className="mt-5 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        Votre prestataire
      </p>
      <p className="mt-1 text-base font-semibold">{company.tradeName}</p>
      <div className="mt-2 grid gap-1 text-sm text-[var(--muted)] sm:grid-cols-2">
        {company.email ? (
          <a href={`mailto:${company.email}`} className="hover:text-[var(--primary)]">
            {company.email}
          </a>
        ) : null}
        {company.phone ? <span>{company.phone}</span> : null}
        {company.website ? (
          <a
            href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--primary)]"
          >
            {company.website}
          </a>
        ) : null}
        <span>{address}</span>
      </div>
    </Card>
  );
}

function DocCard({ doc, kind }: { doc: TrackingDoc; kind: "paid" | "ongoing" | "quote" }) {
  const isQuote = doc.documentType === "QUOTE";
  const isCredit = doc.documentType === "CREDIT_NOTE";
  const label = isQuote ? "Devis" : isCredit ? "Avoir" : "Facture";
  const status = isQuote ? doc.quoteStatus ?? doc.status : doc.status;
  const statusLbl = isQuote
    ? quoteStatusLabelClient[status] ?? quoteStatusLabel[status] ?? status
    : isCredit
      ? invoiceStatusLabelClient[status] ?? statusLabel[status] ?? status
      : invoiceStatusLabelClient[status] ?? invoiceStatusLabel[status] ?? status;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            <span className="font-mono text-sm">{doc.number ?? "Brouillon"}</span>
            <Badge tone={statusTone(status)}>{statusLbl}</Badge>
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {doc.issueDate ? `Reçu le ${formatDate(doc.issueDate)}` : "Non reçu"}
            {kind === "ongoing" && doc.dueDate ? ` · échéance ${formatDate(doc.dueDate)}` : ""}
            {isQuote && doc.validUntil ? ` · valable jusqu'au ${formatDate(doc.validUntil)}` : ""}
          </p>
        </div>
        <div className="text-right">
          {typeof doc.totalCents === "number" ? (
            <p className="tabular-nums font-semibold">{formatEUR(doc.totalCents)}</p>
          ) : null}
          {kind === "ongoing" && typeof doc.remainingCents === "number" ? (
            <p className="text-xs text-[var(--muted)]">
              reste {formatEUR(doc.remainingCents)} à régler
            </p>
          ) : null}
        </div>
      </div>

      {kind === "ongoing" &&
      typeof doc.paidCents === "number" &&
      typeof doc.totalCents === "number" &&
      doc.totalCents > 0 ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg)]">
          <div
            className="h-full rounded-full bg-[var(--primary)]"
            style={{ width: `${Math.min(100, (doc.paidCents / doc.totalCents) * 100)}%` }}
          />
        </div>
      ) : null}

      {kind === "paid" && doc.payments && doc.payments.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-xs">
          {doc.payments.map((p, i) => (
            <li key={i} className="flex justify-between">
              <span className="text-[var(--muted)]">
                Réglé le {formatDate(p.paidAt)} · {paymentMethodLabel[p.method] ?? p.method}
              </span>
              {typeof p.amountCents === "number" ? (
                <span className="tabular-nums">{formatEUR(p.amountCents)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {isQuote && doc.milestones && doc.milestones.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-xs">
          {doc.milestones.map((m, i) => (
            <li key={i} className="flex justify-between">
              <span className="text-[var(--muted)]">
                {m.label} ({(m.percentBps / 100).toFixed(0)} %) · {m.status}
              </span>
              {typeof m.amountCents === "number" ? (
                <span className="tabular-nums">{formatEUR(m.amountCents)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {doc.downloadToken ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <a
            href={`/api/public/documents/${doc.downloadToken}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-[var(--primary)] hover:underline"
          >
            Télécharger le PDF
          </a>
        </div>
      ) : null}
    </Card>
  );
}

function SubCard({ sub }: { sub: TrackingSub }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">Abonnement</span>
            <Badge tone="teal">Actif</Badge>
          </div>
          <p className="mt-1 text-sm">{sub.label}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Prochaine échéance : {formatDate(sub.nextInvoiceAt)} · prélèvement le {sub.billingDay} du mois
          </p>
        </div>
        {typeof sub.amountCents === "number" ? (
          <p className="tabular-nums font-semibold">{formatEUR(sub.amountCents)}/mois</p>
        ) : null}
      </div>
    </Card>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? "bg-white text-[var(--text)] shadow-sm" : "text-[var(--muted)] hover:text-[var(--text)]"
      }`}
    >
      {children}
      {count > 0 ? (
        <span
          className={`rounded-full px-1.5 py-0.5 text-xs ${
            active ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "bg-[var(--bg)] text-[var(--muted)]"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Card className="p-6 text-center text-sm text-[var(--muted)]">{children}</Card>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-12">
      <div className={`mx-auto ${wide ? "max-w-3xl" : "max-w-lg"}`}>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
