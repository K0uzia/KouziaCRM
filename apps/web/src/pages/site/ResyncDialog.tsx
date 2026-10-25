import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

type Change = { path: string; value: unknown };
type DocPlan = {
  id: string;
  label: string;
  filled: Change[];
  removed: string[];
  skipped: Array<{ path: string; message: string }>;
  blocked: Array<{ path: string; message: string }>;
};
type Plan = { planId: string; docs: DocPlan[] };

const preview = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
};
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * « Resynchroniser depuis le site » : la liste des écarts d'abord (champs vides de l'ERP que le site remplit, champs que
 * le site ne connaît plus), puis l'application confirmée. Un texte saisi dans l'ERP n'est jamais remplacé.
 */
export function ResyncDialog({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    api<Plan>("/api/site/editor/resync")
      .then((p) => !cancelled && setPlan(p))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Site illisible"));
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  const applicable = plan?.docs.filter((d) => (d.filled.length || d.removed.length) && !d.blocked.length) ?? [];
  const filled = applicable.reduce((n, d) => n + d.filled.length, 0);
  const removed = applicable.reduce((n, d) => n + d.removed.length, 0);

  async function apply() {
    if (!plan) return;
    setBusy(true);
    try {
      await api("/api/site/editor/resync", { method: "POST", body: JSON.stringify({ planId: plan.planId }) });
      toast.success(`${plural(filled, "texte repris", "textes repris")} du site. Le site change à la prochaine publication.`);
      onApplied();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Resynchronisation impossible");
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Resynchroniser depuis le site"
      description="Les champs vides reprennent le texte que le site affiche (contenu publié, sinon texte par défaut du site). Un texte saisi dans l'ERP n'est jamais remplacé."
      wide
      fullScreenMobile
    >
      {error ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-[var(--danger)]">{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Réessayer
          </Button>
        </div>
      ) : !plan ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Lecture du site…
        </p>
      ) : (
        <div className="space-y-4">
          <p className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3 text-sm">
            Un champ repris devient un texte de l&apos;ERP : un changement futur du texte par défaut du site ne s&apos;y appliquera plus. Pour qu&apos;il suive de nouveau le site, utilisez « Revenir au texte par défaut du site » sous ce champ.
          </p>
          {!filled && !removed ? (
            <p className="text-sm" role="status">
              Rien à reprendre : chaque texte du site est déjà dans l&apos;ERP.
            </p>
          ) : null}
          {plan.docs.every((d) => !d.filled.length && !d.removed.length && !d.skipped.length) ? null : (
            <ul className="space-y-3">
              {plan.docs
                .filter((d) => d.filled.length || d.removed.length || d.skipped.length)
                .map((d) => (
                  <li key={d.id} className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3">
                    <h3 className="text-sm font-semibold">{d.label}</h3>
                    <p className="text-sm text-[var(--muted)]">
                      {[
                        d.filled.length ? plural(d.filled.length, "champ vide rempli", "champs vides remplis") : null,
                        d.removed.length ? plural(d.removed.length, "champ retiré du site", "champs retirés du site") : null,
                        d.skipped.length ? plural(d.skipped.length, "texte non repris", "textes non repris") : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    {d.blocked.length ? (
                      <p className="mt-1 text-sm text-[var(--danger)]">
                        Non appliqué : ce document a déjà des champs à corriger ({d.blocked.map((b) => `${b.path || "document"} : ${b.message}`).join(" ; ")}).
                      </p>
                    ) : null}
                    <details className="mt-2 text-sm">
                      <summary className="min-h-11 cursor-pointer content-center">Voir le détail</summary>
                      <ul className="mt-1 space-y-1 break-words">
                        {d.filled.map((c) => (
                          <li key={c.path}>
                            <code className="text-[var(--primary)]">{c.path}</code> : {preview(c.value)}
                          </li>
                        ))}
                        {d.removed.map((p) => (
                          <li key={p}>
                            <code className="text-[var(--primary)]">{p}</code> : retiré (le site ne l&apos;utilise plus)
                          </li>
                        ))}
                        {d.skipped.map((s) => (
                          <li key={s.path}>
                            <code className="text-[var(--primary)]">{s.path}</code> : non repris ({s.message})
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
            </ul>
          )}
          <ModalActions>
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
              Annuler
            </Button>
            <Button type="button" disabled={busy || (!filled && !removed)} onClick={() => void apply()}>
              {busy ? "Reprise…" : filled ? `Reprendre ${plural(filled, "texte", "textes")}` : "Appliquer"}
            </Button>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}
