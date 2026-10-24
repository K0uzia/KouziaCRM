import { useEffect, useId, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLink, faUserPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isLocalClientId } from "@/lib/offline/queue";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Checkbox, Field } from "@/components/ui/Field";
import { Combobox } from "@/components/ui/Combobox";
import { ClientFormEditor, prefillToForm } from "@/components/clients/ClientForm";

/** Expéditeur d'un fil sans client (GET /api/emails/:threadId, senderSuggestion). */
export type SenderSuggestion = {
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  /** Fiche qui porte déjà l'adresse (créée après le fil). */
  knownClient: { id: string; displayName: string } | null;
};

type LinkResult = { client: { id: string; displayName: string }; linkedThreads: number; contactAdded: boolean };

const threadsText = (n: number) => (n > 1 ? `${n} fils rattachés` : "fil rattaché");

/**
 * Encart en tête d'un fil dont l'expéditeur n'est lié à aucun client : « Créer un client » (fiche préremplie, modifiable)
 * ou « Associer à un client existant ». Rien n'est créé sans action ; ce fil et les autres fils de l'adresse sont
 * rattachés ensuite, et l'encart disparaît.
 */
export function SenderClientPanel({ threadId, suggestion, onLinked }: { threadId: string; suggestion: SenderSuggestion; onLinked: () => void }) {
  const titleId = useId();
  const [creating, setCreating] = useState(false);
  const [associating, setAssociating] = useState(false);
  const [clients, setClients] = useState<Array<{ id: string; displayName: string }> | null>(null);
  const [clientId, setClientId] = useState("");
  const [addContact, setAddContact] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!associating || clients) return;
    api<Array<{ id: string; displayName: string }>>("/api/clients")
      .then(setClients)
      .catch((e: unknown) => {
        setClients([]);
        toast.error(e instanceof Error ? e.message : "Clients indisponibles");
      });
  }, [associating, clients]);

  async function link(targetId: string, withContact: boolean): Promise<LinkResult | null> {
    setBusy(true);
    try {
      return await api<LinkResult>(`/api/emails/${threadId}/link-client`, {
        method: "POST",
        body: JSON.stringify({ clientId: targetId, addContact: withContact }),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rattachement impossible");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function associate(targetId: string, withContact: boolean) {
    const res = await link(targetId, withContact);
    if (!res) return;
    toast.success(
      `Associé à ${res.client.displayName} : ${threadsText(res.linkedThreads)}${res.contactAdded ? `, ${suggestion.email} ajouté comme contact` : ""}`,
    );
    onLinked();
  }

  const name = [suggestion.firstName, suggestion.lastName].filter(Boolean).join(" ");
  const prefill = prefillToForm({ name: name || null, email: suggestion.email, phone: null, company: suggestion.company });

  return (
    <Card className="mt-3 space-y-3 border border-[var(--border)] p-4" role="region" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-semibold break-words">
        {suggestion.knownClient
          ? `${suggestion.email} est l'adresse de ${suggestion.knownClient.displayName}`
          : `Aucun client ne correspond à ${suggestion.email}`}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap" role="group" aria-label="Client de ce message">
        {suggestion.knownClient ? (
          <Button disabled={busy} onClick={() => void associate(suggestion.knownClient!.id, false)}>
            <FontAwesomeIcon icon={faLink} className="h-4 w-4" aria-hidden />
            Rattacher à {suggestion.knownClient.displayName}
          </Button>
        ) : (
          <Button onClick={() => setCreating(true)}>
            <FontAwesomeIcon icon={faUserPlus} className="h-4 w-4" aria-hidden />
            Créer un client
          </Button>
        )}
        <Button variant="secondary" aria-expanded={associating} onClick={() => setAssociating((v) => !v)}>
          <FontAwesomeIcon icon={faLink} className="h-4 w-4" aria-hidden />
          Associer à un client existant
        </Button>
      </div>

      {associating ? (
        <div className="space-y-2 border-t border-[var(--border)] pt-3">
          <Field label="Client">
            <Combobox
              label="Client"
              groups={[{ heading: "", options: (clients ?? []).map((c) => ({ value: c.id, label: c.displayName })) }]}
              value={clientId}
              onChange={setClientId}
              placeholder={clients ? "Choisir un client" : "Chargement des clients…"}
              searchPlaceholder="Nom du client"
              emptyText="Aucun client ne correspond."
              disabled={!clients}
            />
          </Field>
          <Checkbox
            label={`Ajouter ${suggestion.email} comme contact de ce client`}
            hint="Ses prochains e-mails seront rattachés à ce client."
            checked={addContact}
            onChange={(e) => setAddContact(e.target.checked)}
          />
          <Button disabled={!clientId || busy} onClick={() => void associate(clientId, addContact)}>
            {busy ? "Association…" : "Associer"}
          </Button>
        </div>
      ) : null}

      <Modal open={creating} onClose={() => setCreating(false)} title="Nouveau client" description="Prérempli depuis l'e-mail : vérifiez avant d'enregistrer." wide fullScreenMobile>
        <ClientFormEditor
          initial={prefill}
          defaultSendPortalAccess={false}
          onCancel={() => setCreating(false)}
          onSuccess={async (client) => {
            setCreating(false);
            // Fiche mise en file hors ligne : le rattachement se fera depuis le message, une fois la fiche envoyée.
            if (isLocalClientId(client.id)) {
              toast.info("Fiche mise en file : rattachez le message une fois la connexion revenue.");
              return;
            }
            const res = await link(client.id, false);
            if (res) toast.success(`Client créé : ${threadsText(res.linkedThreads)}`);
            onLinked();
          }}
        />
      </Modal>
    </Card>
  );
}
