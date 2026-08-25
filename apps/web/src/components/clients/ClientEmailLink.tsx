import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Textarea } from "@/components/ui/Field";

export function ClientEmailLink({
  email,
  name,
  defaultSubject,
}: {
  email: string | null | undefined;
  name?: string;
  defaultSubject?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [body, setBody] = useState(
    name ? `Bonjour ${name},\n\n` : "Bonjour,\n\n",
  );

  if (!email) {
    return <span className="text-[var(--muted)]">Pas d&apos;email</span>;
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({ to: email, subject, body }),
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Envoi…" : "Envoyer"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
