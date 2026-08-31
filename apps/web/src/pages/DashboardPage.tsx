import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  faCoins,
  faWallet,
  faBuildingColumns,
  faFileInvoiceDollar,
  faUsers,
  faStar,
  faChartLine,
  faFilePen,
  faBell,
} from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card, KpiCard, PageHeader, StatRow } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { ObligationsReminder } from "@/components/obligations/ObligationsReminder";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const RevenueChart = lazy(() => import("@/components/dashboard/RevenueChart"));

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

type MrrData = {
  mrrCents: number;
  arrCents: number;
  activeCount: number;
};

export function DashboardPage() {
  const [scope, setScope] = useState("month");
  const [data, setData] = useState<DashboardData | null>(null);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [mrr, setMrr] = useState<MrrData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payoutEnabled, setPayoutEnabled] = useState(false);
  const [payoutHasBeneficiary, setPayoutHasBeneficiary] = useState(false);
  const [payoutConfirm, setPayoutConfirm] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);

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
    ])
      .then(([d, r, m, p]) => {
        if (!cancelled) {
          setData(d);
          setReminders(r);
          if (m) setMrr(m);
          setPayoutEnabled(p.enabled);
          setPayoutHasBeneficiary(p.hasBeneficiary);
          setError(null);
        }
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

  if (loading && !data) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;
  if (error || !data) return <p className="text-sm text-[var(--danger)]">{error ?? "Erreur"}</p>;

  const cf = data.cashflow;
  const echeanceDue =
    data.echeance &&
    data.echeance.status !== "PAID" &&
    data.echeance.amountDueCents > 0;
  const pendingTotal = data.pendingWithBalance.reduce((s, i) => s + i.remaining, 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Accueil"
        subtitle={data.company.tradeName ?? data.company.legalName}
      />

      <div className="flex flex-wrap gap-2">
        <Link to="/quotes?new=1">
          <Button variant="secondary" className="h-9 px-4 text-xs">
            Nouveau devis
          </Button>
        </Link>
        <Link to="/payments">
          <Button className="h-9 px-4 text-xs">Encaisser</Button>
        </Link>
        <Link to="/invoices">
          <Button variant="ghost" className="h-9 px-4 text-xs">
            Factures
          </Button>
        </Link>
        {payoutEnabled && payoutHasBeneficiary ? (
          <Button
            variant="ghost"
            className="h-9 px-4 text-xs"
            disabled={!cf || cf.resteNetCents <= 0}
            onClick={() => setPayoutConfirm(true)}
          >
            Virer mon salaire
          </Button>
        ) : (
          <Link to="/settings">
            <Button variant="ghost" className="h-9 px-4 text-xs">
              {!payoutHasBeneficiary
                ? "Configurer mon virement"
                : "Activer virement salaire"}
            </Button>
          </Link>
        )}
      </div>

      <ObligationsReminder />

      {echeanceDue ? (
        <Card className="border-[var(--warning)]/30 p-4">
          <p className="text-xs font-medium text-[var(--warning)]">Échéance URSSAF</p>
          <p className="mt-1 text-sm text-[var(--text)]">
            {data.echeance.periodLabel} :{" "}
            <span className="font-semibold tabular-nums">
              {formatEUR(data.echeance.amountDueCents)}
            </span>
            {" · "}
            échéance {formatDate(data.echeance.deadline)}
          </p>
          <Link
            to="/urssaf"
            className="mt-2 inline-block text-xs font-medium text-[var(--primary)] hover:underline"
          >
            Voir déclarations
          </Link>
        </Card>
      ) : null}

      {/* KPI row (4 cartes comme le shot Dribbble) */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Encaissé"
          value={formatEUR(cf.totalEncaisseCents)}
          icon={faCoins}
          iconTone="green"
        />
        <KpiCard
          label="Reste net"
          value={formatEUR(cf.resteNetCents)}
          icon={faWallet}
          iconTone="purple"
        />
        <KpiCard
          label="URSSAF"
          value={formatEUR(cf.urssafCents)}
          icon={faBuildingColumns}
          iconTone="blue"
        />
        <KpiCard
          label="À encaisser"
          value={formatEUR(pendingTotal)}
          icon={faFileInvoiceDollar}
          iconTone="orange"
        />
      </div>

      {/* Graphique + stats rapides */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="h-80 p-6 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-[var(--text)]">
              Répartition des encaissements
            </h2>
            <Select
              className="w-auto"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="week">Semaine</option>
              <option value="month">Mois</option>
              <option value="year">Année</option>
            </Select>
          </div>
          <div className="h-[calc(100%-2.75rem)]">
            <Suspense
              fallback={
                <div className="h-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-hover)]" />
              }
            >
              <RevenueChart data={data.chart} />
            </Suspense>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 text-base font-semibold text-[var(--text)]">En un coup d'oeil</h2>
          <p className="mb-2 text-xs text-[var(--muted)]">Indicateurs complémentaires</p>
          <div className="divide-y divide-[var(--border)]">
            {mrr && mrr.activeCount > 0 ? (
              <StatRow
                icon={faUsers}
                label="Abonnements actifs"
                value={mrr.activeCount}
                iconTone="blue"
              />
            ) : null}
            <StatRow
              icon={faFilePen}
              label="Brouillons"
              value={data.drafts}
              iconTone="purple"
            />
            <StatRow
              icon={faBell}
              label="Relances en attente"
              value={reminders.length}
              iconTone="orange"
            />
            {mrr && mrr.mrrCents > 0 ? (
              <StatRow
                icon={faStar}
                label="Revenus récurrents"
                value={formatEUR(mrr.mrrCents)}
                iconTone="green"
              />
            ) : null}
            <StatRow
              icon={faChartLine}
              label="Trésorerie + CFE"
              value={formatEUR(cf.tresorerieEtCfeCents)}
              iconTone="neutral"
            />
          </div>
        </Card>
      </div>

      {reminders.length > 0 ? (
        <Card className="p-5">
          <h2 className="mb-3 text-base font-semibold">Relances à envoyer</h2>
          <ul className="divide-y divide-[var(--border)] text-sm">
            {reminders.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <Link
                    to={
                      r.documentType === "QUOTE" ? `/quotes/${r.id}` : `/invoices/${r.id}`
                    }
                    className="font-medium hover:text-[var(--primary)]"
                  >
                    {r.number ?? "Document"} · {r.client.displayName}
                  </Link>
                  <p className="text-xs text-[var(--muted)]">
                    {r.documentType === "QUOTE" ? "Devis" : "Facture"} ·{" "}
                    {r.reminderCount} relance(s)
                  </p>
                </div>
                <Button
                  className="h-8 px-3 text-xs"
                  onClick={() => void sendReminder(r.id)}
                >
                  Envoyer
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="p-5">
        <h2 className="mb-3 text-base font-semibold">Factures à encaisser</h2>
        {data.pendingWithBalance.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Aucune facture en attente.{" "}
            <Link to="/invoices" className="text-[var(--primary)] hover:underline">
              Voir les factures
            </Link>
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {data.pendingWithBalance.map((inv) => (
              <li key={inv.id} className="flex justify-between gap-4 py-3">
                <Link to={`/invoices/${inv.id}`} className="hover:text-[var(--primary)]">
                  {inv.number} · {inv.displayName}
                </Link>
                <span className="tabular-nums font-medium">{formatEUR(inv.remaining)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
