import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperclip, faPen } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Button, ButtonLink } from "@/components/ui/Button";
import { templatePath } from "@/lib/email-review";
import { Field, Input, Textarea } from "@/components/ui/Field";

/** E-mail tel que l'ERP l'enverrait (brouillon renvoyé par l'API) : rien n'est parti. */
export type EmailDraft = { to: string; subject: string; text: string; attachments: string[]; templateKey?: string | null };

/**
 * « Vérifier l'e-mail » (E6c, décision d'Alexandre du 23/10/2026) : tout envoi sur clic passe par cette fenêtre.
 * Destinataire, objet et message tels que l'ERP les enverrait, modifiables ; pièces jointes listées. « Envoyer »
 * transmet l'objet et le message relus ; « Ne pas envoyer » ferme sans rien envoyer.
 */
export function VerifyEmailDialog({
  open,
  title,
  description,
  draftUrl,
  note,
  sendLabel = "Envoyer",
  onSend,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  /** Route GET du brouillon (ex. /api/clients/:id/portal/welcome/draft). */
  draftUrl: string;
  /** Précision affichée sous le message (ex. « {{lien}} est remplacé par le lien personnel à l'envoi »). */
  note?: string;
  sendLabel?: string;
  onSend: (edits: { subject: string; text: string }) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDraft(null);
    setError(null);
    api<EmailDraft>(draftUrl)
      .then((d) => {
        if (cancelled) return;
        setDraft(d);
        setSubject(d.subject);
        setText(d.text);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Brouillon indisponible");
      });
    return () => {
      cancelled = true;
    };
  }, [open, draftUrl, attempt]);

  async function send() {
    setBusy(true);
    try {
      await onSend({ subject: subject.trim(), text: text.trim() });
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(draft) && subject.trim() !== "" && text.trim() !== "";
  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={title} description={description ?? "Relisez et modifiez l'e-mail avant de l'envoyer."} wide fullScreenMobile>
      {error ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-[var(--danger)]">{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Réessayer
          </Button>
        </div>
      ) : !draft ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Préparation de l'e-mail…
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void send();
          }}
        >
          <p className="text-sm">
            <span className="text-[var(--muted)]">À : </span>
            <span className="break-all">{draft.to}</span>
          </p>
          <Field label="Objet">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} autoComplete="off" />
          </Field>
          <Field label="Message" hint={note ?? "La mise en page aux couleurs de l'ERP et les mentions légales sont ajoutées à l'envoi."}>
            <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} required maxLength={20000} />
          </Field>
          {draft.templateKey ? (
            <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-[var(--muted)]">Vos corrections ne valent que pour cet envoi. Pour les prochains e-mails de ce type, modifiez le modèle.</p>
              <ButtonLink variant="secondary" to={templatePath(draft.templateKey)}>
                <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
                Modifier le modèle
              </ButtonLink>
            </div>
          ) : null}
          {draft.attachments.length ? (
            <div className="text-sm">
              <p className="font-medium">Pièces jointes</p>
              <ul className="mt-1 space-y-1">
                {draft.attachments.map((name) => (
                  <li key={name} className="flex min-w-0 items-center gap-2 text-[var(--muted)]">
                    <FontAwesomeIcon icon={faPaperclip} className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 break-all">{name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ModalActions>
            <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
              Ne pas envoyer
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy ? "Envoi…" : sendLabel}
            </Button>
          </ModalActions>
        </form>
      )}
    </Modal>
  );
}
