import { useState } from "react";
import { Link } from "react-router-dom";
import { formatEUR } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Badge, Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";

export type MarketMilestone = {
  id: string;
  position: number;
  label: string;
  percentBps: number;
  amountCents: number;
  triggerText: string;
  status: string;
  dueDate?: string | null;
  checkoutUrl?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
  manualReference?: string | null;
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

function statusTone(status: string): "neutral" | "amber" | "green" | "blue" | "red" {
  if (status === "PAID") return "green";
  if (status === "INVOICED") return "blue";
  if (status === "DUE" || status === "OVERDUE") return "amber";
  if (status === "FAILED") return "red";
  if (status === "PENDING") return "neutral";
  return "neutral";
}

function statusLabel(status: string): string {
  if (status === "PAID") return "Payé";
  if (status === "INVOICED") return "Facturé";
  if (status === "DUE") return "Exigible";
  if (status === "OVERDUE") return "En retard";
  if (status === "FAILED") return "Échoué";
  if (status === "CANCELLED") return "Annulé";
  if (status === "PENDING") return "À venir";
  return status;
}

export function MarketTimeline({
  market,
  onGenerateAcompte,
  onGenerateSolde,
  onManualPay,
  onSavePaymentLink,
  busyId,
  allowManualLink = true,
}: {
  market: MarketView;
  onGenerateAcompte: (milestoneId: string) => void;
  onGenerateSolde: (force?: boolean) => void;
  onManualPay?: (milestoneId: string) => void;
  onSavePaymentLink?: (
    milestoneId: string,
    checkoutUrl: string,
    sendEmail: boolean,
  ) => Promise<void> | void;
  busyId?: string | null;
  allowManualLink?: boolean;
}) {
  const { progress, milestones, balance } = market;
  const hasPending = balance.pendingMilestones.length > 0;
  const maxPos = Math.max(...milestones.map((x) => x.position), 0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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
        {allowManualLink ? (
          <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs leading-relaxed text-[var(--muted)]">
            Revolut Pro : créez un <strong className="text-[var(--text)]">Payment Link</strong>{" "}
            dans l&apos;app (montant = jalon), collez l&apos;URL ici, puis envoyez au client.
            Quand il a payé : Marquer payé.
          </p>
        ) : null}
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
          const canInvoice =
            (m.status === "PENDING" || m.status === "DUE") &&
            !m.invoiceId &&
            !isSolde;
          const canManualPay =
            onManualPay &&
            m.status !== "PAID" &&
            m.status !== "CANCELLED" &&
            !isSolde;
          const canLink =
            allowManualLink &&
            onSavePaymentLink &&
            m.status !== "PAID" &&
            m.status !== "CANCELLED";
          const draft = drafts[m.id] ?? m.checkoutUrl ?? "";

          return (
            <li key={m.id} className="space-y-3 px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-3">
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
                    {m.dueDate
                      ? ` · échéance ${new Date(m.dueDate).toLocaleDateString("fr-FR")}`
                      : ""}
                  </p>
                  {m.checkoutUrl ? (
                    <a
                      href={m.checkoutUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-xs text-[var(--primary)] hover:underline"
                    >
                      Lien de paiement
                    </a>
                  ) : null}
                  {m.invoice?.number ? (
                    <Link
                      to={`/invoices/${m.invoice.id}`}
                      className="mt-1 ml-2 inline-block font-mono text-xs text-[var(--primary)] hover:underline"
                    >
                      {m.invoice.number}
                    </Link>
                  ) : null}
                </div>

                {canManualPay ? (
                  <Button
                    variant="secondary"
                    className="h-8 shrink-0 px-3 text-xs"
                    disabled={busyId === `pay-${m.id}`}
                    onClick={() => onManualPay(m.id)}
                  >
                    Marquer payé
                  </Button>
                ) : null}
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
              </div>

              {canLink ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    className="py-2 text-xs"
                    placeholder="https://revolut.me/… ou lien Payment Link"
                    value={draft}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))
                    }
                  />
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-9 px-3 text-xs"
                      disabled={busyId === `link-${m.id}` || !draft.trim()}
                      onClick={() =>
                        void onSavePaymentLink?.(m.id, draft.trim(), false)
                      }
                    >
                      Enregistrer
                    </Button>
                    <Button
                      type="button"
                      className="h-9 px-3 text-xs"
                      disabled={busyId === `link-${m.id}` || !draft.trim()}
                      onClick={() =>
                        void onSavePaymentLink?.(m.id, draft.trim(), true)
                      }
                    >
                      Envoyer au client
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
