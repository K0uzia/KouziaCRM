import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";

export type MessageSender = {
  address: string;
  domain: string | null;
  isClient: boolean;
  locked: boolean;
  rule: { id: string; kind: string; value: string; action: string } | null;
};

type Props = {
  messageId: string;
  sender: MessageSender;
  /** Règle changée : le corps est relu (images, bannière). blocked : ranger aussi ce fil dans Indésirables. */
  onChanged: (blocked: boolean) => void;
};

/** Boutons du message : bloquer l'expéditeur ou lui faire confiance (adresse ou domaine), ou retirer la règle. */
export function SenderRuleActions({ messageId, sender, onChanged }: Props) {
  const [ask, setAsk] = useState<"BLOCK" | "TRUST" | null>(null);
  const [kind, setKind] = useState<"ADDRESS" | "DOMAIN">("ADDRESS");
  const [busy, setBusy] = useState(false);

  // Client : toujours de confiance, rien à régler. Formulaire sans adresse du prospect : rien à viser.
  if (sender.isClient || sender.locked) return null;

  async function save() {
    if (!ask) return;
    setBusy(true);
    try {
      await api("/api/emails/sender-rules", {
        method: "POST",
        body: JSON.stringify({ kind, action: ask, messageId }),
      });
      toast.success(ask === "BLOCK" ? "Expéditeur bloqué" : "Expéditeur ajouté aux expéditeurs de confiance");
      const blocked = ask === "BLOCK";
      setAsk(null);
      onChanged(blocked);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function removeRule() {
    if (!sender.rule) return;
    setBusy(true);
    try {
      await api(`/api/emails/sender-rules/${sender.rule.id}`, { method: "DELETE" });
      toast.success(sender.rule.action === "BLOCK" ? "Expéditeur débloqué" : "Expéditeur retiré de la confiance");
      onChanged(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retrait impossible");
    } finally {
      setBusy(false);
    }
  }

  const rule = sender.rule;
  const ruleTarget = rule ? (rule.kind === "DOMAIN" ? `le domaine ${rule.value}` : rule.value) : "";

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--muted)]">
      {rule ? (
        <>
          <span className="min-w-0 break-words">
            {rule.action === "BLOCK" ? `Expéditeur bloqué (${ruleTarget}).` : `Expéditeur de confiance (${ruleTarget}).`}
          </span>
          <button type="button" className="link min-h-11" disabled={busy} onClick={() => void removeRule()}>
            {rule.action === "BLOCK" ? "Débloquer" : "Retirer la confiance"}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="link min-h-11" onClick={() => { setKind("ADDRESS"); setAsk("BLOCK"); }}>
            Bloquer l'expéditeur
          </button>
          <button type="button" className="link min-h-11" onClick={() => { setKind("ADDRESS"); setAsk("TRUST"); }}>
            Faire confiance
          </button>
        </>
      )}

      <Modal
        open={ask !== null}
        onClose={() => !busy && setAsk(null)}
        title={ask === "BLOCK" ? "Bloquer cet expéditeur ?" : "Faire confiance à cet expéditeur ?"}
      >
        <p className="text-sm text-[var(--text)]">
          {ask === "BLOCK"
            ? "Ce message et les suivants iront dans Indésirables sur la boîte mail, sans notification. Vous pourrez débloquer dans Réglages, E-mail."
            : "Ses messages ne seront jamais bloqués et leurs images s'afficheront d'office."}
        </p>
        <fieldset className="mt-3 space-y-1">
          <legend className="text-sm font-semibold">Viser</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="regle-cible" checked={kind === "ADDRESS"} onChange={() => setKind("ADDRESS")} />
            <span className="min-w-0 break-all">Cette adresse : {sender.address}</span>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name="regle-cible"
              checked={kind === "DOMAIN"}
              disabled={!sender.domain}
              aria-describedby={sender.domain ? undefined : "regle-domaine-note"}
              onChange={() => setKind("DOMAIN")}
            />
            <span className="min-w-0 break-all">
              {sender.domain ? `Tout le domaine ${sender.domain}` : "Tout le domaine"}
              {!sender.domain ? (
                <span id="regle-domaine-note" className="block text-xs text-[var(--muted)]">
                  Indisponible pour une messagerie grand public ou le domaine de votre entreprise.
                </span>
              ) : null}
            </span>
          </label>
        </fieldset>
        <ModalActions>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsk(null)}>
            Annuler
          </Button>
          <Button type="button" variant={ask === "BLOCK" ? "danger" : "primary"} disabled={busy} onClick={() => void save()}>
            {busy ? "…" : ask === "BLOCK" ? "Bloquer" : "Faire confiance"}
          </Button>
        </ModalActions>
      </Modal>
    </div>
  );
}
