import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import {
  EMAIL_TEMPLATES,
  applyTemplate,
  type EmailTemplateId,
} from "@/lib/email-templates";

export function ClientEmailLink({
  email,
  name,
  clientId,
  defaultSubject,
  defaultTemplate = "blank",
}: {
  email: string | null | undefined;
  name?: string;
  clientId?: string;
  defaultSubject?: string;
  defaultTemplate?: EmailTemplateId;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const initial = applyTemplate(defaultTemplate, { clientName: name });
  const [templateId, setTemplateId] = useState<EmailTemplateId>(defaultTemplate);
  const [subject, setSubject] = useState(defaultSubject ?? initial.subject);
  const [body, setBody] = useState(initial.body);

  if (!email) {
    return <span className="text-[var(--muted)]">Pas d&apos;email</span>;
  }

  function onTemplateChange(id: EmailTemplateId) {
    setTemplateId(id);
    const applied = applyTemplate(id, { clientName: name });
    setSubject(defaultSubject && id === "blank" ? defaultSubject : applied.subject);
    setBody(applied.body);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({ to: email, subject, body, clientId }),
      });
      toast.success("Email envoyé");
      setOpen(false);
    } catch {
      const mailto = `mailto:${encodeURIComponent(email!)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = mailto;
      toast.message("Ouverture du client mail (SMTP indisponible)");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const composeHref = clientId
    ? `/inbox/compose?clientId=${encodeURIComponent(clientId)}&template=${templateId}`
    : `/inbox/compose`;

  return (
    <>
      <button
        type="button"
        className="text-[var(--primary)] hover:underline"
        onClick={() => setOpen(true)}
      >
        {email}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Composer un email">
        <form onSubmit={send} className="space-y-4">
          <Field label="Destinataire">
            <Input value={email} readOnly />
          </Field>
          <Field label="Modèle">
            <Select
              value={templateId}
              onChange={(e) => onTemplateChange(e.target.value as EmailTemplateId)}
            >
              {EMAIL_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Objet">
            <Input
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </Field>
          <Field label="Message">
            <Textarea
              required
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              to={composeHref}
              className="text-xs text-[var(--primary)] hover:underline"
              onClick={() => setOpen(false)}
            >
              Ouvrir dans Emails
            </Link>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Envoi…" : "Envoyer"}
              </Button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}
