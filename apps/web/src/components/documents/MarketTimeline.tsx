import { Link } from "react-router-dom";
import { formatEUR } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Badge, Card } from "@/components/ui/Card";

export type MarketMilestone = {
  id: string;
  position: number;
  label: string;
  percentBps: number;
  amountCents: number;
  triggerText: string;
  status: string;
  invoiceId: string | null;
  invoice: {
    id: string;
    number: string | null;
    status: string;
    invoiceType: string;
    totalCents: number;
    paidCents: number;
  } | null;
};

export type MarketView = {
  quote: {
    id: string;
    number: string | null;
    totalCents: number;
  };
  milestones: MarketMilestone[];
  progress: {
    milestonesPaid: number;
    milestonesTotal: number;
    encaisseCents: number;
    marketTotalCents: number;
    encaissePercent: number;
  };
  balance: {
    balanceDueCents: number;
    pendingMilestones: Array<{ id: string; label: string }>;
  };
};

function statusTone(status: string): "neutral" | "amber" | "green" | "blue" {
  if (status === "PAID") return "green";
  if (status === "INVOICED") return "blue";
  if (status === "PENDING") return "amber";
  return "neutral";
}

function statusLabel(status: string): string {
  if (status === "PAID") return "Payé";
  if (status === "INVOICED") return "Facturé";
  if (status === "PENDING") return "À facturer";
  return status;
}

export function MarketTimeline({
  market,
  onGenerateAcompte,
  onGenerateSolde,
  busyId,
}: {
  market: MarketView;
  onGenerateAcompte: (milestoneId: string) => void;
  onGenerateSolde: (force?: boolean) => void;
  busyId?: string | null;
}) {
  const { progress, milestones, balance } = market;
  const hasPending = balance.pendingMilestones.length > 0;
  const maxPos = Math.max(...milestones.map((x) => x.position), 0);

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Échéancier du marché</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              {progress.milestonesPaid}/{progress.milestonesTotal} réglés ·{" "}
              {progress.encaissePercent} % encaissé · solde{" "}
              {formatEUR(balance.balanceDueCents)}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="h-8 px-3 text-xs"
            disabled={busyId === "solde"}
            onClick={() => onGenerateSolde(false)}
          >
            Facture de solde
          </Button>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--bg)]">
          <div
            className="h-full rounded-full bg-[var(--primary)]"
            style={{ width: `${Math.min(100, progress.encaissePercent)}%` }}
          />
        </div>
      </div>

      <ul className="divide-y divide-[var(--border)]">
        {milestones.map((m) => {
          const isSolde =
            m.label.toLowerCase().includes("solde") || m.position === maxPos;
          const canInvoice = m.status === "PENDING" && !m.invoiceId && !isSolde;

          return (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">
                    {m.label}
                    <span className="ml-1.5 font-normal text-[var(--muted)]">
                      {(m.percentBps / 100).toFixed(0)} %
                    </span>
                  </p>
                  <Badge tone={statusTone(m.status)}>{statusLabel(m.status)}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {formatEUR(m.amountCents)}
                  {m.triggerText ? ` · ${m.triggerText}` : ""}
                </p>
                {m.invoice?.number ? (
                  <Link
                    to={`/invoices/${m.invoice.id}`}
                    className="mt-1 inline-block font-mono text-xs text-[var(--primary)] hover:underline"
                  >
                    {m.invoice.number}
                  </Link>
                ) : null}
              </div>

              {canInvoice ? (
                <Button
                  className="h-8 shrink-0 px-3 text-xs"
                  disabled={busyId === m.id}
                  onClick={() => onGenerateAcompte(m.id)}
                >
                  Facturer
                </Button>
              ) : null}
              {isSolde && m.status === "PENDING" && !m.invoiceId ? (
                <Button
                  variant="secondary"
                  className="h-8 shrink-0 px-3 text-xs"
                  disabled={busyId === "solde"}
                  onClick={() => onGenerateSolde(!hasPending)}
                >
                  Solde
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
