import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
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

  if (!open) return null;

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compose-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-[var(--surface)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 id="compose-title" className="font-semibold">
            Nouveau message
          </h2>
          <Button variant="secondary" onClick={onClose}>
            Fermer
          </Button>
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
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
              className="text-sm text-[var(--primary)]"
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
              className="text-xs text-[var(--muted)]"
              onClick={() => setHtmlMode((v) => !v)}
            >
              {htmlMode ? "Mode texte brut" : "Mode HTML simple"}
            </button>
          </div>
          <Field label="Message">
            <Textarea
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] p-4">
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button disabled={pending} onClick={() => void send()}>
            Envoyer
          </Button>
        </div>
      </div>
    </div>
  );
}
