import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperPlane, faXmark } from "@fortawesome/free-solid-svg-icons";
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
      {/* Téléphone : plein écran, « Envoyer » toujours visible en haut ; grand écran : fenêtre centrée. */}
      <div className="relative z-10 flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-[var(--radius-lg)] sm:border sm:border-[var(--border)] sm:shadow-[var(--shadow)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-5 sm:py-3">
          <span className="sm:hidden">
            <Button variant="ghost" onClick={onClose} aria-label="Fermer sans envoyer">
              <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden />
            </Button>
          </span>
          <h2 id="compose-title" className="min-w-0 flex-1 truncate font-semibold">
            {defaults.inReplyTo ? "Répondre" : "Nouveau message"}
          </h2>
          <span className="sm:hidden">
            <Button disabled={pending} onClick={() => void send()}>
              <FontAwesomeIcon icon={faPaperPlane} className="h-4 w-4" aria-hidden />
              Envoyer
            </Button>
          </span>
          <span className="hidden sm:block">
            <Button variant="secondary" onClick={onClose}>
              Fermer
            </Button>
          </span>
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
            <Textarea
              rows={12}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
        </div>
        <div className="hidden shrink-0 justify-end gap-2 border-t border-[var(--border)] px-5 py-4 sm:flex">
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
