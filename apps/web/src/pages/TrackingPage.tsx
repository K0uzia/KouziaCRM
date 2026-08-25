import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { formatDate } from "@/lib/format";

type TrackingDoc = {
  id: string;
  number: string | null;
  documentType: string;
  status: string;
  quoteStatus?: string | null;
  issueDate: string | null;
  validUntil: string | null;
  dueDate: string | null;
  totalCents?: number;
  milestones?: Array<{
    label: string;
    percentBps: number;
    status: string;
    triggerText: string;
    amountCents?: number;
  }>;
};

type TrackingResult = {
  clientNumber: string | null;
  displayName: string;
  documents: TrackingDoc[];
};

export function TrackingPage() {
  const [clientNumber, setClientNumber] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<TrackingResult | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/public/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNumber, accessCode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Accès refusé");
      }
      setData(body as TrackingResult);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-12">
      <div className="mx-auto max-w-lg">
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
            {busy ? "Vérification…" : "Accéder"}
          </Button>
        </form>

        {data ? (
          <div className="mt-8 space-y-4">
            <p className="text-sm">
              <span className="font-mono font-semibold text-[var(--primary)]">
                {data.clientNumber}
              </span>
              <span className="text-[var(--muted)]"> · {data.displayName}</span>
            </p>
            {data.documents.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Aucun document pour le moment.</p>
            ) : (
              data.documents.map((d) => (
                <div
                  key={d.id}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4 text-sm"
                >
                  <p className="font-medium">
                    {d.documentType === "QUOTE" ? "Devis" : "Facture"}{" "}
                    {d.number ?? ""}
                  </p>
                  <p className="text-[var(--muted)]">
                    Statut : {d.quoteStatus ?? d.status} · {formatDate(d.issueDate)}
                  </p>
                  {typeof d.totalCents === "number" ? (
                    <p className="mt-1 tabular-nums">
                      {(d.totalCents / 100).toLocaleString("fr-FR", {
                        style: "currency",
                        currency: "EUR",
                      })}
                    </p>
                  ) : null}
                  {d.milestones && d.milestones.length > 0 ? (
                    <ul className="mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-xs">
                      {d.milestones.map((m, i) => (
                        <li key={i}>
                          {m.label} ({(m.percentBps / 100).toFixed(0)} %) - {m.status}
                          {typeof m.amountCents === "number"
                            ? ` - ${(m.amountCents / 100).toLocaleString("fr-FR", {
                                style: "currency",
                                currency: "EUR",
                              })}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
