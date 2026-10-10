import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { NeedsEditor, type ClientNeed } from "@/components/clients/NeedsEditor";

const SAVE_DELAY_MS = 600;

/**
 * Fiche client : besoins éditables, case « traité », enregistrés peu après chaque modification.
 * `initial` n'est lu qu'au montage : la page passe key={clientId} pour changer de client.
 */
export function ClientNeedsCard({ clientId, initial }: { clientId: string; initial: ClientNeed[] }) {
  const [needs, setNeeds] = useState<ClientNeed[]>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = useRef(false);
  // Liste pas encore envoyée : partie au démontage (navigation dans le délai d'enregistrement).
  const pending = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (!pending.current) return;
      void fetch(`/api/clients/${clientId}/needs`, {
        method: "PUT",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: pending.current,
      });
    },
    [clientId],
  );

  useEffect(() => {
    if (!dirty.current) return;
    // Libellés vides ou en cours de saisie : non envoyés (le champ les retire à la sortie).
    const payload = needs
      .map((n) => ({ ...n, label: n.label.replace(/\s+/g, " ").trim() }))
      .filter((n) => n.label);
    const body = JSON.stringify({ needs: payload });
    pending.current = body;
    const timer = setTimeout(() => {
      setState("saving");
      pending.current = null;
      void api<{ needs: ClientNeed[] }>(`/api/clients/${clientId}/needs`, { method: "PUT", body })
        .then(() => setState("saved"))
        .catch((e: Error) => {
          setState("error");
          toast.error(`Besoins non enregistrés : ${e.message}`);
        });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [clientId, needs]);

  const open = needs.filter((n) => !n.done).length;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Besoins{needs.length > 0 ? ` (${open} à traiter sur ${needs.length})` : ""}
        </h2>
        <p
          className={`text-xs ${state === "error" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}
          aria-live="polite"
        >
          {state === "saving"
            ? "Enregistrement…"
            : state === "saved"
              ? "Enregistré"
              : state === "error"
                ? "Non enregistré : modifiez un besoin pour réessayer"
                : ""}
        </p>
      </div>
      {needs.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">Aucun besoin noté. Ajoutez-en pour préparer le devis.</p>
      ) : null}
      <NeedsEditor
        needs={needs}
        showDone
        onChange={(next) => {
          dirty.current = true;
          setNeeds(next);
        }}
      />
    </Card>
  );
}
