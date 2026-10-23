import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperclip } from "@fortawesome/free-solid-svg-icons";
import { api, formatDate } from "@/lib/api";
import { REVIEW_CHANGED_EVENT, type ReviewDetail } from "@/lib/email-review";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1000))} Ko`;

/**
 * Un e-mail de la file « E-mails à valider » : relu (objet et message modifiables), puis validé (il part avec la file
 * d'envoi) ou refusé avec un motif gardé dans l'ERP, jamais transmis au client. Un e-mail refusé se consulte seulement.
 */
export function ReviewEmailDialog({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void | Promise<void> }) {
  const [email, setEmail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setEmail(null);
    setError(null);
    setRejecting(false);
    setReason("");
    api<ReviewDetail>(`/api/emails/review/${id}`)
      .then((e) => {
        if (cancelled) return;
        setEmail(e);
        setSubject(e.subject);
        setText(e.text);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "E-mail introuvable"));
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  async function act(path: "approve" | "reject") {
    if (!email) return;
    setBusy(true);
    try {
      const edited = { ...(subject.trim() !== email.subject ? { subject: subject.trim() } : {}), ...(text.trim() !== email.text.trim() ? { text: text.trim() } : {}) };
      await api(`/api/emails/review/${email.id}/${path}`, { method: "POST", body: JSON.stringify(path === "approve" ? edited : { reason: reason.trim() }) });
      toast.success(path === "approve" ? "E-mail validé : il part avec la file d'envoi" : "E-mail refusé : il ne partira pas");
      window.dispatchEvent(new Event(REVIEW_CHANGED_EVENT));
      onClose();
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action impossible");
    } finally {
      setBusy(false);
    }
  }

  if (!id) return null;
  const pending = email?.status === "REVIEW";
  const edited = Boolean(email) && text.trim() !== email!.text.trim();
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={pending || !email ? "E-mail à valider" : "E-mail refusé"}
      description={pending || !email ? "Relisez l'e-mail ; il ne part qu'une fois validé." : "Refusé : il n'est pas parti et ne partira pas."}
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
      ) : !email ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Chargement de l'e-mail…
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !pending) return;
            if (rejecting) {
              if (reason.trim()) void act("reject");
            } else if (subject.trim() && text.trim()) void act("approve");
          }}
        >
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-[var(--muted)]">À</dt>
            <dd className="min-w-0 break-all">{email.to}</dd>
            {email.clientName ? (
              <>
                <dt className="text-[var(--muted)]">Client</dt>
                <dd className="min-w-0">{email.clientName}</dd>
              </>
            ) : null}
            <dt className="text-[var(--muted)]">Type</dt>
            <dd className="min-w-0">
              {email.familyLabel ?? "E-mail automatique"}
              {email.documentNumber ? `, ${email.documentNumber}` : ""}
            </dd>
            <dt className="text-[var(--muted)]">Origine</dt>
            <dd className="min-w-0">
              {email.originLabel ?? "Non précisée"}, le {formatDate(email.createdAt)}
            </dd>
          </dl>
          {email.clientWaiting && pending ? <Badge tone="amber">Le client attend cet e-mail</Badge> : null}
          {pending ? (
            <>
              <Field label="Objet">
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} autoComplete="off" disabled={rejecting} />
              </Field>
              <Field
                label="Message"
                hint={
                  email.hasCustomLayout && edited
                    ? "Message modifié : il part avec la mise en page standard de l'ERP (texte et liens), mentions légales comprises."
                    : "La mise en page de l'ERP et les mentions légales sont ajoutées à l'envoi."
                }
              >
                <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} required maxLength={20000} disabled={rejecting} />
              </Field>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">{email.subject}</p>
              <p className="whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3 text-sm">{email.text}</p>
              {email.rejectReason ? (
                <p className="text-sm">
                  <span className="text-[var(--muted)]">Motif du refus : </span>
                  {email.rejectReason}
                </p>
              ) : null}
            </>
          )}
          {email.attachments.length ? (
            <div className="text-sm">
              <p className="font-medium">Pièces jointes</p>
              <ul className="mt-1 space-y-1">
                {email.attachments.map((a) => (
                  <li key={a.filename} className="flex min-w-0 items-center gap-2 text-[var(--muted)]">
                    <FontAwesomeIcon icon={faPaperclip} className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 break-all">{a.filename}</span>
                    <span className="shrink-0 tabular-nums">{kb(a.bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {pending && rejecting ? (
            <Field label="Motif du refus" hint="Gardé dans l'ERP, jamais transmis au client.">
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
            </Field>
          ) : null}
          <ModalActions>
            {!pending ? (
              <Button type="button" variant="secondary" onClick={onClose}>
                Fermer
              </Button>
            ) : rejecting ? (
              <>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => setRejecting(false)}>
                  Annuler le refus
                </Button>
                <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
                  {busy ? "Refus…" : "Refuser l'e-mail"}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="danger-ghost" disabled={busy} onClick={() => setRejecting(true)}>
                  Refuser…
                </Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
                  Plus tard
                </Button>
                <Button type="submit" disabled={busy || !subject.trim() || !text.trim()}>
                  {busy ? "Validation…" : "Valider et envoyer"}
                </Button>
              </>
            )}
          </ModalActions>
        </form>
      )}
    </Modal>
  );
}
