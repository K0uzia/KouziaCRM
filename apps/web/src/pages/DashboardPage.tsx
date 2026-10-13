import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faClipboardCheck,
  faEnvelope,
  faFileInvoice,
  faFilePen,
  faFileSignature,
  faLandmark,
  faPenToSquare,
  faUserPlus,
  faWallet,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { toast } from "sonner";
import { useLiveRefresh } from "@/lib/notifications";
import { api, formatEUR } from "@/lib/api";
import { formatAgoMinutes, formatDate, MAIL_SYNC_STALE_MIN, minutesSince } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useFeatures } from "@/lib/features";
import { PayoutDialog } from "@/components/payouts/PayoutDialog";
import { WithdrawalDialog } from "@/components/finance/WithdrawalDialog";
import type { MonthlyFlow } from "@/components/dashboard/FlowsChart";
import { useMediaQuery } from "@/lib/use-media-query";

type OwnerPay = { availableCents: number; paidThisMonthCents: number; flows: MonthlyFlow[] };
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";

const RevenueChart = lazy(() => import("@/components/dashboard/RevenueChart"));
const FlowsChart = lazy(() => import("@/components/dashboard/FlowsChart"));

type Scope = "week" | "month" | "year";

type DashboardData = {
  company: { legalName: string; tradeName: string | null };
  cashflow: {
    totalEncaisseCents: number;
    urssafCents: number;
    fraisCents: number;
    fraisBps: number;
    placementsCents: number;
    cfeCents: number;
    tresorerieCents: number;
    tresorerieEtCfeCents: number;
    resteNetCents: number;
  };
  chart: Array<{
    label: string;
    ca: number;
    urssaf: number;
    tresorerie: number;
    salaire: number;
    cfe: number;
  }>;
  echeance: {
    periodLabel: string;
    amountDueCents: number;
    deadline: string;
    status: string;
    paidAt: string | null;
    periodKey: string;
  };
  drafts: number;
  /** Paiement en 3 fois : étape du 2e acompte à choisir, 2e acompte exigible à facturer. */
  deposit2?: {
    missingStep: Array<{ quoteId: string; number: string | null; displayName: string; amountCents: number }>;
    toInvoice: Array<{ quoteId: string; number: string | null; displayName: string; amountCents: number }>;
  };
  pendingWithBalance: Array<{
    id: string;
    number: string | null;
    displayName: string;
    remaining: number;
  }>;
};

type ReminderRow = {
  id: string;
  number: string | null;
  documentType: string;
  totalCents: number;
  nextReminderAt: string | null;
  reminderCount: number;
  client: { id: string; displayName: string; clientNumber?: string | null };
};

type MrrData = { mrrCents: number; arrCents: number; activeCount: number };

type ThreadRow = {
  id: string;
  subject: string;
  lastMessageAt: string;
  unreadCount?: number;
  client: { id: string; displayName: string } | null;
  lastFrom: string;
  preview: string;
  direction: string | null;
};

type CfeObligation = { label: string; dueDate: string; amountCents: number | null };

type ObligationsSummary = {
  summary: { late: number; urgent: number; open: number; upcoming: number; pending: number };
  nextDue: { label: string; displayStatus: string; daysLate: number | null; daysRemaining: number | null } | null;
};

const SCOPE_LABEL: Record<Scope, string> = {
  week: "cette semaine",
  month: "ce mois-ci",
  year: "cette année",
};

function greeting(): string {
  const h = new Date().getHours();
  return h < 18 ? "Bonjour" : "Bonsoir";
}

/** Ligne de la colonne « À traiter » : icône d'état, texte, action à droite. */
function TodoRow({
  icon,
  tone,
  title,
  detail,
  action,
}: {
  icon: IconDefinition;
  tone: "danger" | "warning" | "primary" | "muted";
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const toneCls = {
    danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
    warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
    primary: "bg-[var(--primary-soft)] text-[var(--primary)]",
    muted: "bg-[var(--surface-hover)] text-[var(--muted)]",
  }[tone];
  return (
    <li className="flex items-center gap-3 py-3">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${toneCls}`}>
        <FontAwesomeIcon icon={icon} className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        {/* Le texte passe à la ligne : un montant ne doit jamais être masqué par une coupure. */}
        <div className="break-words text-sm font-medium">{title}</div>
        {detail ? <div className="break-words text-xs text-[var(--muted)]">{detail}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-5">
      <h2 className="text-sm font-semibold">{children}</h2>
      {action}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>("month");
  const [data, setData] = useState<DashboardData | null>(null);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [mrr, setMrr] = useState<MrrData | null>(null);
  const [obligations, setObligations] = useState<ObligationsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cfeObligation, setCfeObligation] = useState<CfeObligation | null>(null);
  const [remindersRunBusy, setRemindersRunBusy] = useState(false);
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [withdrawalOpen, setWithdrawalOpen] = useState(false);
  const [ownerPay, setOwnerPay] = useState<OwnerPay | null>(null);
  // Téléphone : 6 derniers mois, lisibles sans défilement horizontal.
  const wideChart = useMediaQuery("(min-width: 640px)");
  const { moduleStripeEnabled } = useFeatures();
  const [liveTick, setLiveTick] = useState(0);
  useLiveRefresh(() => setLiveTick((t) => t + 1));

  // Rechargée à chaque changement signalé (nouveau message, messages marqués lus) : non-lus à jour.
  const [mailSyncAge, setMailSyncAge] = useState<number | null>(null);
  useEffect(() => {
    api<ThreadRow[]>("/api/emails")
      .then((rows) => setThreads(rows.slice(0, 5)))
      .catch(() => setThreads(null));
    // Synchro automatique en panne : alerte dans « À traiter » (boîte configurée seulement).
    api<{ imapConfigured?: boolean; lastSyncAt?: string | null }>("/api/emails/sync-status")
      .then((s) => setMailSyncAge(s.imapConfigured ? (minutesSince(s.lastSyncAt) ?? Infinity) : null))
      .catch(() => setMailSyncAge(null));
  }, [liveTick]);
  const mailStale = mailSyncAge !== null && mailSyncAge > MAIL_SYNC_STALE_MIN;
  const deposit2Rows = [
    ...(data?.deposit2?.toInvoice ?? []).map((q) => ({ ...q, kind: "toInvoice" as const })),
    ...(data?.deposit2?.missingStep ?? []).map((q) => ({ ...q, kind: "missingStep" as const })),
  ];
  const url = useMemo(() => `/api/dashboard?scope=${scope}&t=${liveTick}`, [scope, liveTick]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api<DashboardData>(url),
      api<ReminderRow[]>("/api/reminders/pending").catch(() => [] as ReminderRow[]),
      api<MrrData>("/api/subscriptions/mrr").catch(() => null as MrrData | null),
      api<{ items: Array<{ type: string; label: string; dueDate: string; amountCents: number | null; displayStatus: string }> }>(
        "/api/obligations",
      ).catch(() => ({ items: [] })),
      api<ObligationsSummary>("/api/obligations/summary").catch(() => null),
    ])
      .then(([d, r, m, ob, os]) => {
        if (cancelled) return;
        setData(d);
        setReminders(r);
        setMrr(m);
        setObligations(os);
        const cfe = ob.items
          .filter((i) => i.type === "CFE_PAYMENT" && i.displayStatus !== "DONE")
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
        setCfeObligation(cfe ? { label: cfe.label, dueDate: cfe.dueDate, amountCents: cfe.amountCents } : null);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Salaire disponible (cumul) et flux mensuels : indépendants de la portée choisie.
  useEffect(() => {
    let cancelled = false;
    api<OwnerPay>("/api/owner-pay")
      .then((p) => !cancelled && setOwnerPay(p))
      .catch(() => !cancelled && setOwnerPay(null));
    return () => {
      cancelled = true;
    };
  }, [liveTick]);

  async function runAllReminders() {
    setRemindersRunBusy(true);
    try {
      const res = await api<{ scheduled: number; enqueued: number; sent: number; errors: string[] }>(
        "/api/reminders/run",
        { method: "POST", body: "{}" },
      );
      toast.success(`Relances : ${res.enqueued} enfilée(s), ${res.sent} envoyée(s)`);
      if (res.errors.length) toast.error(res.errors.join(" · "));
      setReminders(await api<ReminderRow[]>("/api/reminders/pending"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setRemindersRunBusy(false);
    }
  }

  async function sendReminder(id: string) {
    try {
      const res = await api<{ emailed: boolean; mailto: string | null }>(
        `/api/invoices/${id}/reminders/send`,
        { method: "POST", body: "{}" },
      );
      if (res.emailed) toast.success("Relance envoyée");
      else if (res.mailto) {
        window.location.href = res.mailto;
        toast.message("Client mail ouvert");
      } else toast.success("Relance enregistrée");
      setReminders(await api<ReminderRow[]>("/api/reminders/pending"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  const firstName = (user?.name ?? "").split(/\s+/)[0];
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  const header = (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm capitalize text-[var(--muted)]">{today}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {greeting()}
          {firstName ? ` ${firstName}` : ""}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Période des indicateurs"
          value={scope}
          onChange={setScope}
          options={[
            { id: "week", label: "Semaine" },
            { id: "month", label: "Mois" },
            { id: "year", label: "Année" },
          ]}
        />
      </div>
    </div>
  );

  const quickActions = (
    <div className="mb-6 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      <ButtonLink to="/payments?new=1" className="col-span-2 sm:col-span-1">
        <FontAwesomeIcon icon={faWallet} className="h-3.5 w-3.5" aria-hidden />
        Encaisser
      </ButtonLink>
      {/* Sous 640 px : libellé court sur une ligne, nom accessible complet (il contient le libellé visible). */}
      <ButtonLink to="/quotes?new=1" variant="secondary" aria-label="Nouveau devis">
        <FontAwesomeIcon icon={faFileSignature} className="h-3.5 w-3.5" aria-hidden />
        <span className="sm:hidden">Devis</span>
        <span className="hidden sm:inline">Nouveau devis</span>
      </ButtonLink>
      <ButtonLink to="/invoices?new=1" variant="secondary" aria-label="Nouvelle facture">
        <FontAwesomeIcon icon={faFileInvoice} className="h-3.5 w-3.5" aria-hidden />
        <span className="sm:hidden">Facture</span>
        <span className="hidden sm:inline">Nouvelle facture</span>
      </ButtonLink>
      <ButtonLink to="/clients?new=1" variant="secondary" aria-label="Nouveau client">
        <FontAwesomeIcon icon={faUserPlus} className="h-3.5 w-3.5" aria-hidden />
        <span className="sm:hidden">Client</span>
        <span className="hidden sm:inline">Nouveau client</span>
      </ButtonLink>
      <ButtonLink to="/inbox/compose" variant="secondary" aria-label="Écrire un mail">
        <FontAwesomeIcon icon={faPenToSquare} className="h-3.5 w-3.5" aria-hidden />
        <span className="sm:hidden">Mail</span>
        <span className="hidden sm:inline">Écrire un mail</span>
      </ButtonLink>
    </div>
  );

  if (loading && !data) {
    return (
      <div>
        {header}
        {quickActions}
        <div className="ui-card h-28 animate-pulse" aria-busy="true" aria-label="Chargement des indicateurs" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div>
        {header}
        <Card className="p-5 text-sm text-[var(--danger)]" role="alert">
          Impossible de charger le tableau de bord : {error ?? "erreur inconnue"}
        </Card>
      </div>
    );
  }

  const cf = data.cashflow;
  // Statuts en minuscules (paid, due, late, clear) : seule une échéance à payer ou en retard est « due ».
  const echeanceDue =
    data.echeance && (data.echeance.status === "due" || data.echeance.status === "late") && data.echeance.amountDueCents > 0;
  const pendingTotal = data.pendingWithBalance.reduce((s, i) => s + i.remaining, 0);
  const os = obligations?.summary;
  const obligationAlerts = os ? os.late + os.urgent + os.open : 0;


  const unreadThreads = (threads ?? []).filter((t) => (t.unreadCount ?? 0) > 0).length;

  return (
    <div>
      {header}
      {quickActions}

      <StatStrip
        className={loading ? "opacity-60" : ""}
        items={[
          { label: `Encaissé ${SCOPE_LABEL[scope]}`, value: formatEUR(cf.totalEncaisseCents), tone: "primary", to: "/receipts" },
          {
            label: "À encaisser",
            value: formatEUR(pendingTotal),
            hint: `${data.pendingWithBalance.length} facture${data.pendingWithBalance.length > 1 ? "s" : ""} ouverte${data.pendingWithBalance.length > 1 ? "s" : ""}`,
            to: "/invoices",
          },
          {
            label: "URSSAF provisionnée",
            shortLabel: "URSSAF",
            value: formatEUR(cf.urssafCents),
            hint: echeanceDue ? `${formatEUR(data.echeance.amountDueCents)} dus le ${formatDate(data.echeance.deadline)}` : "à jour",
            to: "/urssaf",
          },
          {
            label: "CFE provisionnée",
            value: formatEUR(cf.cfeCents),
            hint: cfeObligation ? `due le ${formatDate(cfeObligation.dueDate)}` : cf.cfeCents > 0 ? "provision mensuelle" : "CFE non renseignée",
          },
          {
            label: "Trésorerie",
            value: formatEUR(cf.tresorerieCents),
            hint: "provision frais et placements",
          },
          { label: "Reste net", value: formatEUR(cf.resteNetCents), hint: "après URSSAF et provisions", tone: "success" },
          {
            label: "Salaire disponible",
            value: formatEUR(ownerPay?.availableCents ?? 0),
            hint: `déjà retiré ${formatEUR(ownerPay?.paidThisMonthCents ?? 0)} ce mois-ci`,
            tone: "success",
            to: "/retraits",
          },
        ]}
      />
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {moduleStripeEnabled ? (
          <Button variant="secondary" onClick={() => setPayoutOpen(true)}>
            Verser sur mon compte
          </Button>
        ) : null}
        <Button onClick={() => setWithdrawalOpen(true)}>Enregistrer un retrait</Button>
      </div>
      <WithdrawalDialog
        open={withdrawalOpen}
        availableCents={ownerPay?.availableCents ?? 0}
        onClose={() => setWithdrawalOpen(false)}
        onDone={() => setLiveTick((t) => t + 1)}
      />
      <PayoutDialog
        open={payoutOpen}
        onClose={() => setPayoutOpen(false)}
        suggestedCents={Math.max(0, cf.resteNetCents)}
        onDone={() => setLiveTick((t) => t + 1)}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {ownerPay && ownerPay.flows.length > 0 ? (
            <Card className="min-w-0 overflow-hidden">
              <SectionTitle>Flux par mois</SectionTitle>
              <p className="px-5 text-sm text-[var(--muted)] sm:px-6">
                Encaissé au-dessus, provisions et retraits en dessous ; la courbe suit le salaire disponible cumulé.
              </p>
              <div className="h-80 p-3 sm:p-5">
                <Suspense fallback={<div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />}>
                  <FlowsChart flows={ownerPay.flows.slice(wideChart ? -12 : -6)} />
                </Suspense>
              </div>
            </Card>
          ) : null}
          <Card className="min-w-0 overflow-hidden">
            <SectionTitle>Répartition des encaissements</SectionTitle>
            <div className="h-72 p-3 sm:p-5">
              <Suspense fallback={<div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />}>
                <RevenueChart data={data.chart} />
              </Suspense>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <SectionTitle
                action={
                  <Link to="/invoices" className="link inline-flex min-h-11 min-w-11 items-center justify-center px-1 text-sm">
                    Toutes
                  </Link>
                }
              >
                Factures à encaisser
              </SectionTitle>
              {data.pendingWithBalance.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">Aucune facture en attente de paiement.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {data.pendingWithBalance.map((inv) => (
                    <li key={inv.id}>
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="flex min-h-12 items-center justify-between gap-3 px-5 py-2.5 text-sm hover:bg-[var(--surface-raised)]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{inv.displayName}</span>
                          <span className="font-mono text-xs text-[var(--muted)]">{inv.number}</span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">{formatEUR(inv.remaining)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="overflow-hidden">
              <SectionTitle>Relances automatiques</SectionTitle>
              {reminders.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Aucune relance en attente.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {reminders.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                      <Link
                        to={r.documentType === "QUOTE" ? `/quotes/${r.id}` : `/invoices/${r.id}`}
                        className="flex min-h-11 min-w-0 flex-col justify-center hover:text-[var(--primary)]"
                      >
                        <span className="block truncate font-medium">{r.client.displayName}</span>
                        <span className="text-xs text-[var(--muted)]">
                          {r.documentType === "QUOTE" ? "Devis" : "Facture"} {r.number ?? ""} · {r.reminderCount} relance
                          {r.reminderCount > 1 ? "s" : ""}
                        </span>
                      </Link>
                      <Button variant="secondary" className="shrink-0 px-3 text-sm" onClick={() => void sendReminder(r.id)}>
                        Envoyer
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-[var(--border)] px-5 py-3">
                <Button variant="ghost" className="w-full text-sm" disabled={remindersRunBusy} onClick={() => void runAllReminders()}>
                  {remindersRunBusy ? "Exécution…" : "Exécuter les rappels maintenant"}
                </Button>
              </div>
            </Card>
          </div>
        </div>

        <div className="order-first space-y-6 xl:order-none">
          <Card className="overflow-hidden">
            <SectionTitle
              action={
                <span className="rounded-full bg-[var(--surface-hover)] px-2 text-xs font-medium tabular-nums leading-6 text-[var(--muted)]">
                  {obligationAlerts + (echeanceDue ? 1 : 0) + (data.drafts > 0 ? 1 : 0) + (mailStale ? 1 : 0) + deposit2Rows.length}
                </span>
              }
            >
              À traiter
            </SectionTitle>
            {obligationAlerts === 0 && !echeanceDue && data.drafts === 0 && !mailStale && deposit2Rows.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Rien en attente. Tout est à jour.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] px-5">
                {mailStale ? (
                  <TodoRow
                    icon={faEnvelope}
                    tone="danger"
                    title="Messagerie : synchronisation automatique arrêtée"
                    detail={
                      mailSyncAge === Infinity
                        ? "Aucune synchronisation enregistrée"
                        : `Dernière synchro ${formatAgoMinutes(mailSyncAge ?? 0)}`
                    }
                    action={
                      <Link to="/inbox" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {deposit2Rows.map((q) => (
                  <TodoRow
                    key={`${q.kind}-${q.quoteId}`}
                    icon={faFileInvoice}
                    tone={q.kind === "toInvoice" ? "warning" : "primary"}
                    title={
                      q.kind === "toInvoice"
                        ? `2e acompte à facturer : ${formatEUR(q.amountCents)}`
                        : "Étape du 2e acompte à choisir"
                    }
                    detail={`${q.displayName}, devis ${q.number ?? ""}`}
                    action={
                      <Link to={`/quotes/${q.quoteId}`} className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ))}
                {os && obligationAlerts > 0 ? (
                  <TodoRow
                    icon={faClipboardCheck}
                    tone={os.late > 0 ? "danger" : os.urgent > 0 ? "warning" : "primary"}
                    title={
                      os.late > 0
                        ? `${os.late} démarche${os.late > 1 ? "s" : ""} en retard`
                        : `${obligationAlerts} démarche${obligationAlerts > 1 ? "s" : ""} à faire`
                    }
                    detail={obligations?.nextDue?.label}
                    action={
                      <Link to="/obligations" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {echeanceDue ? (
                  <TodoRow
                    icon={faLandmark}
                    tone="warning"
                    title={`URSSAF ${data.echeance.periodLabel} : ${formatEUR(data.echeance.amountDueCents)}`}
                    detail={`À déclarer avant le ${formatDate(data.echeance.deadline)}`}
                    action={
                      <Link to="/urssaf" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Déclarer <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
                {data.drafts > 0 ? (
                  <TodoRow
                    icon={faFilePen}
                    tone="muted"
                    title={`${data.drafts} brouillon${data.drafts > 1 ? "s" : ""} à finaliser`}
                    action={
                      <Link to="/quotes" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                        Voir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                      </Link>
                    }
                  />
                ) : null}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle
              action={
                <Link to="/inbox" className="link inline-flex min-h-11 items-center gap-1 text-sm">
                  Ouvrir <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" aria-hidden />
                </Link>
              }
            >
              <span className="inline-flex items-center gap-2">
                Messagerie
                {unreadThreads > 0 ? (
                  <span className="rounded-full bg-[var(--primary)] px-1.5 text-[0.6875rem] font-semibold leading-5 text-[var(--primary-fg)]">
                    {unreadThreads} non lu{unreadThreads > 1 ? "s" : ""}
                  </span>
                ) : null}
              </span>
            </SectionTitle>
            {threads === null ? (
              <div className="px-5 py-6 text-center text-sm text-[var(--muted)]">
                <p>Boîte mail non connectée.</p>
                <Link to="/settings?tab=email" className="link mt-1 inline-flex min-h-11 items-center">
                  Configurer la messagerie
                </Link>
              </div>
            ) : threads.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-[var(--muted)]">Aucun échange pour le moment.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {threads.map((t) => {
                  const unread = (t.unreadCount ?? 0) > 0;
                  return (
                    <li key={t.id}>
                      <Link to={`/inbox/${t.id}`} className="flex gap-3 px-5 py-3 hover:bg-[var(--surface-raised)]">
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-[var(--primary)]" : "bg-transparent"}`}
                          aria-label={unread ? "non lu" : undefined}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className={`truncate text-sm ${unread ? "font-semibold" : ""}`}>
                              {t.client?.displayName ?? t.lastFrom}
                            </span>
                            <span className="shrink-0 text-xs text-[var(--muted)]">{formatDate(t.lastMessageAt)}</span>
                          </span>
                          <span className="block truncate text-xs text-[var(--muted)]">{t.subject}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle>En un coup d'œil</SectionTitle>
            <dl className="divide-y divide-[var(--border)] px-5 text-sm">
              {[
                {
                  label: "Revenus récurrents",
                  value: mrr && mrr.mrrCents > 0 ? `${formatEUR(mrr.mrrCents)} / mois` : "Aucun",
                  to: "/abonnements",
                },
                { label: "Abonnements actifs", value: String(mrr?.activeCount ?? 0), to: "/abonnements" },
                { label: "Brouillons", value: String(data.drafts), to: "/quotes" },
                { label: "Relances en attente", value: String(reminders.length), to: null },
              ].map((row) => (
                <div key={row.label} className="flex min-h-11 items-center justify-between gap-3">
                  <dt className="text-[var(--muted)]">{row.label}</dt>
                  <dd className="font-semibold tabular-nums">
                    {row.to ? (
                      <Link to={row.to} className="inline-flex min-h-11 min-w-11 items-center justify-end hover:text-[var(--primary)]">
                        {row.value}
                      </Link>
                    ) : (
                      row.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>

    </div>
  );
}
