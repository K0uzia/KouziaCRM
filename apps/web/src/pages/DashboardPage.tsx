import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { ObligationsReminder } from "@/components/obligations/ObligationsReminder";

type DashboardData = {
  company: { legalName: string; tradeName: string | null };
  cashflow: {
    totalEncaisseCents: number;
    urssafCents: number;
    fraisCents: number;
    placementsCents: number;
    resteNetCents: number;
  };
  chart: Array<{ label: string; ca: number; urssaf: number }>;
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

  const url = useMemo(() => `/api/dashboard?scope=${scope}`, [scope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api<DashboardData>(url),
      api<ReminderRow[]>("/api/reminders/pending").catch(() => [] as ReminderRow[]),
      api<MrrData>("/api/subscriptions/mrr").catch(() => null as MrrData | null),
    ])
      .then(([d, r, m]) => {
        if (!cancelled) {
          setData(d);
          setReminders(r);
          if (m) setMrr(m);
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tableau de bord"
        subtitle={data.company.tradeName ?? data.company.legalName}
        actions={
          <Select
            className="w-auto"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="month">Ce mois</option>
            <option value="quarter">Ce trimestre</option>
            <option value="year">Cette année</option>
          </Select>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Link
          to="/quotes"
          className="inline-flex h-9 items-center rounded-[var(--radius)] border border-[var(--border-strong)] bg-white px-3 text-xs font-medium hover:bg-[var(--bg)]"
        >
          Nouveau devis
        </Link>
        <Link
          to="/invoices"
          className="inline-flex h-9 items-center rounded-[var(--radius)] border border-[var(--border-strong)] bg-white px-3 text-xs font-medium hover:bg-[var(--bg)]"
        >
          Factures
        </Link>
        <Link
          to="/payments"
          className="inline-flex h-9 items-center rounded-[var(--radius)] bg-[var(--primary)] px-3 text-xs font-medium text-white hover:bg-[var(--primary-hover)]"
        >
          Encaisser
        </Link>
        <Link
          to="/obligations"
          className="inline-flex h-9 items-center rounded-[var(--radius)] border border-[var(--border-strong)] bg-white px-3 text-xs font-medium hover:bg-[var(--bg)]"
        >
          Obligations / URSSAF
        </Link>
      </div>

      <ObligationsReminder />

      {echeanceDue ? (
        <Card className="border-[var(--warning)]/40 p-4">
          <p className="text-xs font-medium text-[var(--warning)]">Échéance URSSAF</p>
          <p className="mt-1 text-sm">
            {data.echeance.periodLabel} :{" "}
            <span className="font-semibold tabular-nums">
              {formatEUR(data.echeance.amountDueCents)}
            </span>
            {" · "}
            échéance {formatDate(data.echeance.deadline)}
            {" · "}
            {data.echeance.status}
          </p>
          <Link
            to="/banque"
            className="mt-2 inline-block text-xs font-medium text-[var(--primary)] hover:underline"
          >
            Voir déclarations
          </Link>
        </Card>
      ) : null}

      {mrr && mrr.activeCount > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs text-[var(--muted)]">CA récurrent (MRR)</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatEUR(mrr.mrrCents)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--muted)]">CA récurrent (ARR)</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatEUR(mrr.arrCents)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-[var(--muted)]">Abonnements actifs</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{mrr.activeCount}</p>
          </Card>
        </div>
      ) : null}

      {reminders.length > 0 ? (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">Relances à envoyer</h2>
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
                    {r.reminderCount} relance(s) · échéance {formatDate(r.nextReminderAt)}
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Encaissé", cf.totalEncaisseCents],
          ["URSSAF", cf.urssafCents],
          ["Frais", cf.fraisCents],
          ["Placements", cf.placementsCents],
          ["Reste net", cf.resteNetCents],
        ].map(([label, cents]) => (
          <Card key={String(label)} className="p-4">
            <p className="text-xs text-[var(--muted)]">{label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {formatEUR(Number(cents))}
            </p>
          </Card>
        ))}
      </div>

      <Card className="h-72 p-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.chart}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="ca" fill="#0f766e" name="Encaissé" radius={[4, 4, 0, 0]} />
            <Bar dataKey="urssaf" fill="#99f6e4" name="URSSAF" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">
          Factures à encaisser
          {data.drafts > 0 ? (
            <span className="ml-2 font-normal text-[var(--muted)]">
              · {data.drafts} brouillon(s)
            </span>
          ) : null}
        </h2>
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
    </div>
  );
}
