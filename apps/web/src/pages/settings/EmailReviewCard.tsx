import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ReviewFamilySetting } from "@/lib/email-review";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type Setting = { autoApprove: string[]; families: ReviewFamilySetting[] };

/**
 * Réglages, E-mail : familles d'e-mails automatiques validées d'office (elles partent sans passer par « E-mails à
 * valider »). Aucune par défaut ; la mise en demeure est toujours validée à la main (refusée aussi par l'API).
 */
export function EmailReviewCard() {
  const [setting, setSetting] = useState<Setting | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<Setting>("/api/settings/email-review")
      .then((s) => {
        if (cancelled) return;
        setSetting(s);
        setSelected(s.autoApprove);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Réglage indisponible"));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const dirty = Boolean(setting) && [...selected].sort().join() !== [...setting!.autoApprove].sort().join();
  async function save() {
    setBusy(true);
    try {
      const s = await api<Setting>("/api/settings/email-review", { method: "PUT", body: JSON.stringify({ autoApprove: selected }) });
      setSetting(s);
      setSelected(s.autoApprove);
      toast.success("Validation des e-mails enregistrée");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 border border-[var(--border)] p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Validation des e-mails automatiques</h2>
        <p className="text-sm text-[var(--muted)]">
          Les e-mails automatiques destinés aux clients attendent votre validation dans{" "}
          <Link to="/emails-a-valider" className="link underline! underline-offset-2">
            E-mails à valider
          </Link>
          . Cochez les familles qui peuvent partir sans relecture. Les codes de connexion et de signature partent toujours aussitôt.
        </p>
      </div>
      {error ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-[var(--danger)]">{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Réessayer
          </Button>
        </div>
      ) : !setting ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Chargement…
        </p>
      ) : (
        <>
          <fieldset className="grid gap-x-6 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
            <legend className="mb-1 text-sm font-semibold">Validées d'office</legend>
            {setting.families.map((f) => (
              <label key={f.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!f.alwaysReviewed && selected.includes(f.id)}
                  disabled={f.alwaysReviewed || busy}
                  aria-describedby={f.alwaysReviewed ? `famille-${f.id}-note` : undefined}
                  onChange={(e) => setSelected((list) => (e.target.checked ? [...list, f.id] : list.filter((x) => x !== f.id)))}
                />
                <span>
                  {f.label}
                  {f.alwaysReviewed ? (
                    <span id={`famille-${f.id}-note`} className="block text-xs text-[var(--muted)]">
                      Toujours validée à la main
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? "Enregistrement…" : "Enregistrer la validation"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
