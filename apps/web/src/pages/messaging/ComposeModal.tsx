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
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compose-title"
    >
      <button
        type="button"
        aria-label="Fermer"
        className="absolute inset-0 bg-[var(--text)]/30 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-[92vh] w-full min-w-0 flex-col overflow-hidden rounded-t-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow)] sm:max-w-2xl sm:rounded-[var(--radius-lg)]">
        <div className="flex h-10 shrink-0 items-center justify-center sm:hidden" aria-hidden>
          <div className="h-1 w-10 rounded-full bg-[var(--muted)]/40" />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2 sm:px-5 sm:py-3">
          <h2 id="compose-title" className="min-w-0 truncate font-semibold">
            Nouveau message
          </h2>
          <Button variant="secondary" onClick={onClose} aria-label="Fermer">
            Fermer
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 sm:p-5">
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
        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-[var(--border)] px-4 py-4 sm:flex-row sm:justify-end sm:px-5 [&_button]:w-full sm:[&_button]:w-auto">
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
