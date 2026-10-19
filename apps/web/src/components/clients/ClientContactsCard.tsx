import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { formatPhoneFr } from "@/lib/format";
import { errorMessage, isNetworkFailure } from "@/lib/network";
import { Badge, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OfflineGuard } from "@/components/ui/OfflineGuard";

export type ClientContact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
};

type Form = { firstName: string; lastName: string; role: string; email: string; phone: string };
const EMPTY: Form = { firstName: "", lastName: "", role: "", email: "", phone: "" };

export function contactName(c: Pick<ClientContact, "firstName" | "lastName" | "role">): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.role || "Contact sans nom";
}

/**
 * Contacts du client (particulier compris). Le contact principal porte les coordonnées de la fiche (espace client,
 * suivi, envois) : le changer, ou modifier son e-mail, met la fiche à jour (onPrimaryChanged la relit).
 */
export function ClientContactsCard({ clientId, onPrimaryChanged }: { clientId: string; onPrimaryChanged: () => void }) {
  const [contacts, setContacts] = useState<ClientContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClientContact | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<ClientContact | null>(null);
  const [toPromote, setToPromote] = useState<ClientContact | null>(null);

  const load = useCallback(() => {
    api<ClientContact[]>(`/api/clients/${encodeURIComponent(clientId)}/contacts`)
      .then((rows) => {
        setContacts(rows);
        setLoadError(null);
      })
      .catch((e: unknown) =>
        setLoadError(isNetworkFailure(e) ? "Non disponible hors ligne : ces contacts ne sont pas encore sur l'appareil." : errorMessage(e, "Contacts non chargés.")),
      );
  }, [clientId]);
  useEffect(load, [load]);

  function open(contact: ClientContact | "new") {
    setEditing(contact);
    setErrors({});
    setForm(
      contact === "new"
        ? EMPTY
        : { firstName: contact.firstName ?? "", lastName: contact.lastName ?? "", role: contact.role ?? "", email: contact.email ?? "", phone: contact.phone ?? "" },
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setErrors({});
    try {
      const path = editing === "new" ? `/api/clients/${encodeURIComponent(clientId)}/contacts` : `/api/clients/${encodeURIComponent(clientId)}/contacts/${editing.id}`;
      await api(path, { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify(form) });
      toast.success(editing === "new" ? "Contact ajouté" : "Contact enregistré");
      const touchedPrimary = editing === "new" ? !(contacts ?? []).some((c) => c.isPrimary) : editing.isPrimary;
      setEditing(null);
      load();
      if (touchedPrimary) onPrimaryChanged();
    } catch (err) {
      const fieldErrors = (err as { fieldErrors?: Partial<Record<keyof Form, string>> }).fieldErrors;
      if (fieldErrors) setErrors(fieldErrors);
      toast.error(errorMessage(err, "Contact non enregistré."));
    } finally {
      setBusy(false);
    }
  }

  async function promote(contact: ClientContact) {
    setBusy(true);
    try {
      await api(`/api/clients/${encodeURIComponent(clientId)}/contacts/${contact.id}/primary`, { method: "POST" });
      toast.success(`${contactName(contact)} est le contact principal`);
      setToPromote(null);
      load();
      onPrimaryChanged();
    } catch (err) {
      toast.error(errorMessage(err, "Contact principal non changé."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(contact: ClientContact) {
    setBusy(true);
    try {
      await api(`/api/clients/${encodeURIComponent(clientId)}/contacts/${contact.id}`, { method: "DELETE" });
      toast.success("Contact supprimé");
      setToDelete(null);
      load();
    } catch (err) {
      toast.error(errorMessage(err, "Contact non supprimé."));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Card className="p-5 text-sm" data-client-contacts>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Contacts</h2>
        <OfflineGuard className="contents">
          <Button variant="ghost" className="text-sm" aria-label="Ajouter un contact" onClick={() => open("new")}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Ajouter
          </Button>
        </OfflineGuard>
      </div>
      {loadError ? <p className="text-[var(--muted)]">{loadError}</p> : null}
      {contacts === null && !loadError ? <div className="h-16 animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-raised)]" aria-hidden /> : null}
      {contacts?.length === 0 ? <p className="text-[var(--muted)]">Aucun contact : le premier ajouté devient le contact principal.</p> : null}
      {contacts?.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {contacts.map((c) => (
            <li key={c.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{contactName(c)}</span>
                {c.isPrimary ? <Badge tone="teal">Principal</Badge> : null}
              </p>
              {c.role && (c.firstName || c.lastName) ? <p className="text-xs text-[var(--muted)]">{c.role}</p> : null}
              {c.email ? (
                <a className="flex min-h-11 items-center break-all text-[var(--primary)] hover:underline" href={`mailto:${c.email}`}>
                  {c.email}
                </a>
              ) : null}
              {c.phone ? (
                <a className="flex min-h-11 items-center text-[var(--primary)] hover:underline" href={`tel:${c.phone.replace(/\s+/g, "")}`}>
                  {formatPhoneFr(c.phone)}
                </a>
              ) : null}
              <OfflineGuard className="flex flex-wrap gap-1 pt-1">
                <Button variant="ghost" className="text-sm" aria-label={`Modifier ${contactName(c)}`} onClick={() => open(c)}>
                  Modifier
                </Button>
                {c.isPrimary ? null : (
                  <>
                    <Button variant="ghost" className="text-sm" aria-label={`Rendre ${contactName(c)} principal`} onClick={() => setToPromote(c)}>
                      Rendre principal
                    </Button>
                    <Button variant="danger-ghost" className="text-sm" aria-label={`Supprimer ${contactName(c)}`} onClick={() => setToDelete(c)}>
                      Supprimer
                    </Button>
                  </>
                )}
              </OfflineGuard>
            </li>
          ))}
        </ul>
      ) : null}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Nouveau contact" : "Modifier le contact"} description="Un nom, un e-mail ou un téléphone au moins.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Prénom" error={errors.firstName}>
              <Input autoComplete="given-name" value={form.firstName} onChange={set("firstName")} maxLength={80} />
            </Field>
            <Field label="Nom" error={errors.lastName}>
              <Input autoComplete="family-name" value={form.lastName} onChange={set("lastName")} maxLength={80} />
            </Field>
          </div>
          <Field label="Fonction" hint="Gérante, comptabilité, standard…" error={errors.role}>
            <Input autoComplete="organization-title" value={form.role} onChange={set("role")} maxLength={80} />
          </Field>
          <Field label="E-mail" error={errors.email}>
            <Input type="email" autoComplete="email" inputMode="email" value={form.email} onChange={set("email")} maxLength={254} />
          </Field>
          <Field label="Téléphone" error={errors.phone}>
            <Input type="tel" autoComplete="tel" inputMode="tel" value={form.phone} onChange={set("phone")} maxLength={40} />
          </Field>
          {editing !== "new" && editing?.isPrimary ? (
            <p className="text-xs text-[var(--muted)]">Contact principal : ses coordonnées sont celles de la fiche (espace client, envois).</p>
          ) : null}
          <ModalActions>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <ConfirmDialog
        open={toPromote !== null}
        title="Changer le contact principal ?"
        message={`${toPromote ? contactName(toPromote) : ""} devient le contact principal : son e-mail et son téléphone deviennent ceux de la fiche, utilisés pour l'espace client et les envois.`}
        confirmLabel="Rendre principal"
        busy={busy}
        onConfirm={() => toPromote && void promote(toPromote)}
        onClose={() => setToPromote(null)}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title="Supprimer ce contact ?"
        message={`${toDelete ? contactName(toDelete) : ""} sera retiré des contacts de ce client.`}
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => toDelete && void remove(toDelete)}
        onClose={() => setToDelete(null)}
      />
    </Card>
  );
}
