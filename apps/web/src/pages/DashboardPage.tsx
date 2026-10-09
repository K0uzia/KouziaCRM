import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faBell,
  faClipboardCheck,
  faFileInvoice,
  faFilePen,
  faLandmark,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { StatStrip } from "@/components/ui/StatStrip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const RevenueChart = lazy(() => import("@/components/dashboard/RevenueChart"));

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
        <div className="truncate text-sm font-medium">{title}</div>
        {detail ? <div className="truncate text-xs text-[var(--muted)]">{detail}</div> : null}
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
  const [payoutEnabled, setPayoutEnabled] = useState(false);
  const [payoutHasBeneficiary, setPayoutHasBeneficiary] = useState(false);
  const [payoutConfirm, setPayoutConfirm] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [cfeObligation, setCfeObligation] = useState<CfeObligation | null>(null);
  const [remindersRunBusy, setRemindersRunBusy] = useState(false);

  const url = useMemo(() => `/api/dashboard?scope=${scope}`, [scope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api<DashboardData>(url),
      api<ReminderRow[]>("/api/reminders/pending").catch(() => [] as ReminderRow[]),
      api<MrrData>("/api/subscriptions/mrr").catch(() => null as MrrData | null),
      api<{ enabled: boolean; hasBeneficiary: boolean }>("/api/payouts/status").catch(() => ({
        enabled: false,
        hasBeneficiary: false,
      })),
      api<{ items: Array<{ type: string; label: string; dueDate: string; amountCents: number | null; displayStatus: string }> }>(
        "/api/obligations",
      ).catch(() => ({ items: [] })),
      api<ObligationsSummary>("/api/obligations/summary").catch(() => null),
    ])
      .then(([d, r, m, p, ob, os]) => {
        if (cancelled) return;
        setData(d);
        setReminders(r);
        setMrr(m);
        setPayoutEnabled(p.enabled);
        setPayoutHasBeneficiary(p.hasBeneficiary);
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
        {payoutEnabled && payoutHasBeneficiary ? (
          <Button
            variant="secondary"
            disabled={!data || data.cashflow.resteNetCents <= 0}
            onClick={() => setPayoutConfirm(true)}
          >
            Virer mon salaire
          </Button>
        ) : payoutEnabled ? (
          <ButtonLink to="/settings?tab=payments" variant="secondary">
            Configurer mon virement
          </ButtonLink>
        ) : null}
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <div>
        {header}
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
  const echeanceDue = data.echeance && data.echeance.status !== "PAID" && data.echeance.amountDueCents > 0;
  const pendingTotal = data.pendingWithBalance.reduce((s, i) => s + i.remaining, 0);
  const os = obligations?.summary;
  const obligationAlerts = os ? os.late + os.urgent + os.open : 0;

  const todoCount =
    obligationAlerts + (echeanceDue ? 1 : 0) + reminders.length + data.pendingWithBalance.length;

  return (
    <div>
      {header}

      <StatStrip
        className={loading ? "opacity-60" : ""}
        items={[
          { label: `Encaissé ${SCOPE_LABEL[scope]}`, value: formatEUR(cf.totalEncaisseCents), tone: "primary" },
          {
            label: "À encaisser",
            value: formatEUR(pendingTotal),
            hint: `${data.pendingWithBalance.length} facture${data.pendingWithBalance.length > 1 ? "s" : ""} ouverte${data.pendingWithBalance.length > 1 ? "s" : ""}`,
          },
          { label: "Reste net", value: formatEUR(cf.resteNetCents), hint: "salaire disponible", tone: "success" },
          {
            label: "URSSAF provisionnée",
            value: formatEUR(cf.urssafCents),
            hint: echeanceDue ? `${formatEUR(data.echeance.amountDueCents)} dus le ${formatDate(data.echeance.deadline)}` : undefined,
          },
        ]}
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <Card className="min-w-0 overflow-hidden">
            <SectionTitle>Répartition des encaissements</SectionTitle>
            <div className="h-72 p-3 sm:p-5">
              <Suspense fallback={<div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />}>
                <RevenueChart data={data.chart} />
              </Suspense>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle>Trésorerie et prévisions</SectionTitle>
            <dl className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-4">
              {[
                {
                  label: "CFE et trésorerie",
                  value: formatEUR(cf.cfeCents + cf.tresorerieCents),
                  hint: cfeObligation ? `CFE due le ${formatDate(cfeObligation.dueDate)}` : null,
                },
                { label: "Brouillons", value: String(data.drafts), hint: data.drafts ? "à finaliser" : null},
                {
                  label: "Abonnements actifs",
                  value: mrr ? String(mrr.activeCount) : "0",
                  hint: mrr && mrr.mrrCents > 0 ? `${formatEUR(mrr.mrrCents)} / mois` : null,
                },
                { label: "Relances en attente", value: String(reminders.length), hint: null },
              ].map((s) => (
                <div key={s.label} className="bg-[var(--surface)] p-4">
                  <dt className="text-xs text-[var(--muted)]">{s.label}</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{s.value}</dd>
                  {s.hint ? <dd className="text-xs text-[var(--muted)]">{s.hint}</dd> : null}
                </div>
              ))}
            </dl>
            {cf.cfeCents <= 0 && !cfeObligation ? (
              <p className="border-t border-[var(--border)] px-5 py-3 text-xs text-[var(--muted)]">
                Montant de CFE non renseigné.{" "}
                <Link to="/settings" className="link">
                  Le renseigner dans les réglages
                </Link>
              </p>
            ) : null}
          </Card>
        </div>

        {/* À traiter */}
        <Card className="order-first h-fit overflow-hidden xl:order-none">
          <SectionTitle
            action={
              <span className="rounded-full bg-[var(--surface-hover)] px-2 text-xs font-medium tabular-nums leading-6 text-[var(--muted)]">
                {todoCount}
              </span>
            }
          >
            À traiter
          </SectionTitle>
          {todoCount === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">Rien en attente. Tout est à jour.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)] px-5">
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
              {reminders.map((r) => (
                <TodoRow
                  key={`rem-${r.id}`}
                  icon={faBell}
                  tone="warning"
                  title={
                    <Link
                      to={r.documentType === "QUOTE" ? `/quotes/${r.id}` : `/invoices/${r.id}`}
                      className="hover:text-[var(--primary)]"
                    >
                      Relancer {r.client.displayName}
                    </Link>
                  }
                  detail={`${r.documentType === "QUOTE" ? "Devis" : "Facture"} ${r.number ?? ""} · ${r.reminderCount} relance${r.reminderCount > 1 ? "s" : ""} déjà envoyée${r.reminderCount > 1 ? "s" : ""}`}
                  action={
                    <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => void sendReminder(r.id)}>
                      Envoyer
                    </Button>
                  }
                />
              ))}
              {data.pendingWithBalance.map((inv) => (
                <TodoRow
                  key={`inv-${inv.id}`}
                  icon={faFileInvoice}
                  tone="primary"
                  title={
                    <Link to={`/invoices/${inv.id}`} className="hover:text-[var(--primary)]">
                      {inv.displayName}
                    </Link>
                  }
                  detail={`Facture ${inv.number ?? ""} à encaisser`}
                  action={<span className="text-sm font-semibold tabular-nums">{formatEUR(inv.remaining)}</span>}
                />
              ))}
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
          {reminders.length > 0 ? (
            <div className="border-t border-[var(--border)] px-5 py-3">
              <Button
                variant="ghost"
                className="w-full text-sm"
                disabled={remindersRunBusy}
                onClick={() => void runAllReminders()}
              >
                {remindersRunBusy ? "Exécution…" : "Envoyer toutes les relances prévues"}
              </Button>
            </div>
          ) : null}
        </Card>
      </div>

      <ConfirmDialog
        open={payoutConfirm}
        onClose={() => !payoutBusy && setPayoutConfirm(false)}
        title="Virer mon salaire"
        message={`Créer un brouillon Revolut de ${formatEUR(cf.resteNetCents)} (reste net du mois) vers le compte personnel ? Le virement restera à confirmer dans l'app Revolut Business.`}
        confirmLabel="Créer le brouillon"
        busy={payoutBusy}
        onConfirm={() => {
          void (async () => {
            setPayoutBusy(true);
            try {
              await api("/api/payouts/salary", {
                method: "POST",
                body: JSON.stringify({ amountCents: cf.resteNetCents }),
              });
              toast.success("Brouillon créé : confirmez dans Revolut");
              setPayoutConfirm(false);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Échec");
            } finally {
              setPayoutBusy(false);
            }
          })();
        }}
      />
    </div>
  );
}
