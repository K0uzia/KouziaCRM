import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFileSignature } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatDate, formatEUR } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Field";

/** État du rachat renvoyé par GET /api/subscriptions/:id (null : l'offre n'a pas de prestation de rachat). */
type BuyoutState = {
  service: { id: string; name: string; unitPriceCents: number; active: boolean };
  periodEndsAt: string;
  remaining: { count: number; unitPriceCents: number; until: string | null; label: string } | null;
  quotes: Array<{ id: string; number: string | null; quoteStatus: string | null; totalCents: number }>;
  canPropose: boolean;
  blockedReason: string | null;
  /** R2 : rachat signé, fin programmée de l'abonnement et transfert du site (suivi). */
  signed: boolean;
  endsAt: string | null;
  transferredAt: string | null;
} | null;

const QUOTE_STATUS: Record<string, { label: string; tone: "green" | "amber" | "neutral" | "red" }> = {
  DRAFT: { label: "Brouillon", tone: "neutral" },
  SENT: { label: "Envoyé", tone: "amber" },
  ACCEPTED: { label: "Signé", tone: "green" },
  REJECTED: { label: "Refusé", tone: "red" },
  EXPIRED: { label: "Expiré", tone: "neutral" },
};

/**
 * Rachat du site (R1) dans la fiche d'un abonnement : prestation de rachat de l'offre, ce que le devis contiendra,
 * devis déjà proposés et action « Proposer le rachat » (devis brouillon, à vérifier avant émission).
 */
export function BuyoutSection({ subscriptionId }: { subscriptionId: string }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; buyout: BuyoutState }>({
    status: "loading",
  });
  const [busy, setBusy] = useState(false);
  const [savingTransfer, setSavingTransfer] = useState(false);
  const navigate = useNavigate();
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api<{ buyout: BuyoutState }>(`/api/subscriptions/${subscriptionId}`)
      .then((r) => !cancelled && setState({ status: "ready", buyout: r.buyout }))
      .catch((e: unknown) => !cancelled && setState({ status: "error", message: e instanceof Error ? e.message : "Erreur" }));
    return () => {
      cancelled = true;
    };
  }, [subscriptionId]);

  async function propose() {
    setBusy(true);
    try {
      const quote = await api<{ id: string }>(`/api/subscriptions/${subscriptionId}/buyout-quote`, { method: "POST" });
      toast.success("Devis de rachat créé en brouillon : vérifiez-le avant de l'émettre");
      // Quitter la page ferme la fiche : la fermer avant relancerait la navigation vers Abonnements (?contrat= retiré).
      navigate(`/quotes/${quote.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Devis de rachat impossible");
    } finally {
      setBusy(false);
    }
  }

  async function toggleTransfer(done: boolean) {
    setSavingTransfer(true);
    try {
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const res = await api<{ transferredAt: string | null }>(`/api/subscriptions/${subscriptionId}/transfer`, {
        method: "PUT",
        body: JSON.stringify({ transferredAt: done ? iso : null }),
      });
      setState((s) => (s.status === "ready" && s.buyout ? { status: "ready", buyout: { ...s.buyout, transferredAt: res.transferredAt } } : s));
      toast.success(done ? "Transfert du site noté" : "Transfert du site retiré");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setSavingTransfer(false);
    }
  }

  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm text-[var(--muted)]">
        Rachat du site : chargement…
      </p>
    );
  }
  if (state.status === "error") {
    return <p className="text-sm text-[var(--danger)]">Rachat du site indisponible : {state.message}</p>;
  }
  const b = state.buyout;
  if (!b) return null;

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-4">
      <h3 id={headingId} className="font-display text-base font-semibold text-[var(--text)]">
        Rachat du site
      </h3>
      <dl className="space-y-1.5 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt className="text-[var(--muted)]">{b.service.name}</dt>
          <dd className="font-medium tabular-nums">{formatEUR(b.service.unitPriceCents)}</dd>
        </div>
        {b.remaining ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-[var(--muted)]">
              {b.remaining.label}
              {b.remaining.until ? `, jusqu'au ${formatDate(b.remaining.until)}` : ""}
            </dt>
            <dd className="tabular-nums">
              {b.remaining.count} × {formatEUR(b.remaining.unitPriceCents)}
            </dd>
          </div>
        ) : null}
        {b.signed && b.endsAt ? (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-[var(--muted)]">Fin de l'abonnement (rachat payé)</dt>
            <dd>{formatDate(b.endsAt)}</dd>
          </div>
        ) : b.signed ? (
          // Décision du 28/10/2026 : l'abonnement prend fin au paiement du rachat, pas à sa signature.
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-[var(--muted)]">Fin de l'abonnement</dt>
            <dd>au paiement du rachat</dd>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className="text-[var(--muted)]">Fin de la période en cours</dt>
            <dd>{formatDate(b.periodEndsAt)}</dd>
          </div>
        )}
      </dl>
      {b.quotes.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {b.quotes.map((q) => {
            const status = QUOTE_STATUS[q.quoteStatus ?? ""] ?? { label: q.quoteStatus ?? "", tone: "neutral" as const };
            return (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link to={`/quotes/${q.id}`} className="link inline-flex min-h-11 items-center underline! underline-offset-2">
                  {q.number ? `Devis ${q.number}` : "Devis de rachat (brouillon)"}
                </Link>
                <span className="inline-flex items-center gap-2">
                  <span className="tabular-nums">{formatEUR(q.totalCents)}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {b.signed ? (
        <Checkbox
          label="Transfert du site effectué"
          hint={b.transferredAt ? `Noté le ${formatDate(b.transferredAt)}. Domaine, accès et fichiers : hors ERP.` : "Domaine, accès et fichiers : à transférer hors ERP, puis à cocher ici."}
          checked={Boolean(b.transferredAt)}
          disabled={savingTransfer}
          onChange={(e) => void toggleTransfer(e.target.checked)}
        />
      ) : null}
      {b.canPropose ? (
        <Button onClick={() => void propose()} disabled={busy}>
          <FontAwesomeIcon icon={faFileSignature} className="h-3.5 w-3.5" aria-hidden />
          {busy ? "Création du devis…" : "Proposer le rachat"}
        </Button>
      ) : (
        <p className="text-xs text-[var(--muted)]">{b.blockedReason}</p>
      )}
    </section>
  );
}
