import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperPlane } from "@fortawesome/free-solid-svg-icons";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { ClientEmailCombobox } from "@/pages/messaging/ClientEmailCombobox";

type Props = {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  defaults?: {
    to?: string;
    clientId?: string;
    threadId?: string;
    inReplyTo?: string;
    subject?: string;
    body?: string;
    documentId?: string;
  };
};

export function ComposeModal({ open, onClose, onSent, defaults = {} }: Props) {
  const [to, setTo] = useState(defaults.to ?? "");
  const [clientId, setClientId] = useState(defaults.clientId ?? "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(defaults.subject ?? "");
  const [body, setBody] = useState(defaults.body ?? "");
  const [htmlMode, setHtmlMode] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setTo(defaults.to ?? "");
      setClientId(defaults.clientId ?? "");
      setSubject(defaults.subject ?? "");
      setBody(defaults.body ?? "");
    }
  }, [open, defaults]);

  async function send() {
    setPending(true);
    try {
      const payload: Record<string, unknown> = {
        to: to.trim() || undefined,
        clientId: clientId || defaults.clientId,
        subject,
        body,
        threadId: defaults.threadId,
        inReplyTo: defaults.inReplyTo,
        documentId: defaults.documentId,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        html: htmlMode ? body.replace(/\n/g, "<br>") : undefined,
      };
      await api("/api/emails/send", { method: "POST", body: JSON.stringify(payload) });
      toast.success("Message envoyé");
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Envoi impossible");
    } finally {
      setPending(false);
    }
  }

  // Primitive Modal : Échap, piège à focus, retour du focus au déclencheur ; plein écran au téléphone,
  // actions dans le pied de la fenêtre (toujours visibles).
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={defaults.inReplyTo ? "Répondre" : "Nouveau message"}
      wide
      fullScreenMobile
      footer={
        <div className="flex flex-wrap justify-end gap-2 [&>*]:flex-[1_1_8rem] sm:[&>*]:flex-none">
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button disabled={pending} onClick={() => void send()}>
            <FontAwesomeIcon icon={faPaperPlane} className="h-4 w-4" aria-hidden />
            {pending ? "Envoi…" : "Envoyer"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="À">
          <ClientEmailCombobox
            value={to}
            onChange={(email, client) => {
              setTo(email);
              setClientId(client?.id ?? "");
            }}
          />
        </Field>
        {!showCc ? (
          <button
            type="button"
            className="inline-flex min-h-11 items-center text-sm text-[var(--primary)]"
            onClick={() => setShowCc(true)}
          >
            Cc / Cci
          </button>
        ) : (
          <>
            <Field label="Cc">
              <Input value={cc} onChange={(e) => setCc(e.target.value)} />
            </Field>
            <Field label="Cci">
              <Input value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Objet">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <button
            type="button"
            className="inline-flex min-h-11 items-center text-xs text-[var(--muted)]"
            onClick={() => setHtmlMode((v) => !v)}
          >
            {htmlMode ? "Mode texte brut" : "Mode HTML simple"}
          </button>
        </div>
        <Field label="Message">
          <Textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
