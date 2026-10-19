import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { ServiceNeedsEditor, pendingNeeds, useNeedsCatalog, type ClientNeeds } from "@/components/clients/ServiceNeedsEditor";

const SAVE_DELAY_MS = 600;

const payload = (needs: ClientNeeds) =>
  JSON.stringify({ services: needs.services.map((n) => ({ serviceId: n.serviceId, done: n.doneAt !== null })), details: needs.details });

/**
 * Fiche client : prestations souhaitées (case « traité ») et Précisions, enregistrées peu après chaque modification.
 * `initial` n'est lu qu'au montage : la page passe key={clientId} pour changer de client.
 */
export function ClientNeedsCard({ clientId, initial }: { clientId: string; initial: ClientNeeds }) {
  const [needs, setNeeds] = useState<ClientNeeds>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const { catalog, error: catalogError } = useNeedsCatalog();
  const dirty = useRef(false);
  // Numéro de la dernière modification : une réponse plus ancienne ne réécrit pas une saisie plus récente.
  const edits = useRef(0);
  // Liste pas encore envoyée : partie au démontage (navigation dans le délai d'enregistrement).
  const pending = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (!pending.current) return;
      void api(`/api/clients/${clientId}/needs`, { method: "PUT", keepalive: true, body: pending.current }).catch(
        (e: Error) => toast.error(`Besoins non enregistrés : ${e.message}`),
      );
    },
    [clientId],
  );

  useEffect(() => {
    if (!dirty.current) return;
    const body = payload(needs);
    const edit = edits.current;
    pending.current = body;
    const timer = setTimeout(() => {
      setState("saving");
      pending.current = null;
      void api<ClientNeeds>(`/api/clients/${clientId}/needs`, { method: "PUT", body })
        .then((saved) => {
          setState("saved");
          // Dates « traité » et état archivé tels qu'enregistrés, si rien n'a changé depuis l'envoi.
          if (edits.current === edit) setNeeds((cur) => ({ ...cur, services: saved.services }));
        })
        .catch((e: Error) => {
          setState("error");
          toast.error(`Besoins non enregistrés : ${e.message}`);
        });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [clientId, needs]);

  const open = pendingNeeds(needs.services).length;
  const total = needs.services.length;

  return (
    <Card className="space-y-3 p-5" data-client-needs>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Besoins{total > 0 ? ` (${open} à traiter sur ${total})` : ""}</h2>
        <p className={`text-xs ${state === "error" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`} aria-live="polite">
          {state === "saving"
            ? "Enregistrement…"
            : state === "saved"
              ? "Enregistré"
              : state === "error"
                ? "Non enregistré : modifiez un besoin pour réessayer"
                : ""}
        </p>
      </div>
      {total === 0 ? (
        <p className="text-sm text-[var(--muted)]">Aucune prestation notée. Choisissez-en dans le catalogue pour préparer le devis.</p>
      ) : null}
      <ServiceNeedsEditor
        value={needs}
        catalog={catalog}
        catalogError={catalogError}
        showDone
        onChange={(next) => {
          dirty.current = true;
          edits.current++;
          setNeeds(next);
        }}
      />
    </Card>
  );
}
