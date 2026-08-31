import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";

export type Client = {
  id: string;
  clientNumber?: string | null;
  accessCode?: string;
  type: "B2B" | "B2C";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  siret: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  notes: string | null;
  hasAccessCode?: boolean;
  onboardingCompletedAt?: string | null;
  accessEmailSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClientFormData = {
  type: "B2B" | "B2C";
  firstName: string;
  lastName: string;
  companyName: string;
  email: string;
  phone: string;
  siret: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  notes: string;
};

export const emptyClientForm = (): ClientFormData => ({
  type: "B2C",
  firstName: "",
  lastName: "",
  companyName: "",
  email: "",
  phone: "",
  siret: "",
  addressLine1: "",
  addressLine2: "",
  postalCode: "",
  city: "",
  country: "FRANCE",
  notes: "",
});

export function clientToForm(c: Client): ClientFormData {
  return {
    type: c.type,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    companyName: c.companyName ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    siret: c.siret ?? "",
    addressLine1: c.addressLine1 ?? "",
    addressLine2: c.addressLine2 ?? "",
    postalCode: c.postalCode ?? "",
    city: c.city ?? "",
    country: c.country ?? "FRANCE",
    notes: c.notes ?? "",
  };
}

export function ClientFormEditor({
  clientId,
  initial,
  onSuccess,
  onCancel,
}: {
  clientId?: string;
  initial?: ClientFormData;
  onSuccess: (client: Client) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ClientFormData>(initial ?? emptyClientForm());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) setForm(initial);
  }, [initial]);

  function set<K extends keyof ClientFormData>(key: K, value: ClientFormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = {
        ...form,
        email: form.email || null,
        phone: form.phone || null,
        siret: form.siret || null,
      };
      const client = await api<Client>(clientId ? `/api/clients/${clientId}` : "/api/clients", {
        method: clientId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      if (!clientId) {
        toast.success(
          `Client créé (${client.clientNumber}). Le code d'accès se génère depuis la fiche client ou après le formulaire d'onboarding.`,
        );
      } else {
        toast.success("Client mis à jour");
      }
      onSuccess(client);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="flex gap-2 rounded-[var(--radius)] bg-[var(--bg)] p-1">
        {(["B2C", "B2B"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => set("type", t)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
              form.type === t
                  ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {t === "B2C" ? "Particulier" : "Professionnel"}
          </button>
        ))}
      </div>

      {form.type === "B2C" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prénom">
            <Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
          </Field>
          <Field label="Nom" hint="Obligatoire">
            <Input required value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Raison sociale" hint="Obligatoire" className="sm:col-span-2">
            <Input
              required
              value={form.companyName}
              onChange={(e) => set("companyName", e.target.value)}
            />
          </Field>
          <Field label="SIRET" hint="14 chiffres">
            <Input
              value={form.siret}
              onChange={(e) => set("siret", e.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
      </div>

      <div className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
        <p className="text-sm font-medium">Adresse de facturation</p>
        <Field label="Adresse">
          <Input value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} />
        </Field>
        <Field label="Complément">
          <Input value={form.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Code postal">
            <Input value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} />
          </Field>
          <Field label="Ville" className="sm:col-span-2">
            <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
        </div>
        <Field label="Pays">
          <Select value={form.country} onChange={(e) => set("country", e.target.value)}>
            <option value="FRANCE">France</option>
            <option value="BELGIQUE">Belgique</option>
            <option value="SUISSE">Suisse</option>
            <option value="LUXEMBOURG">Luxembourg</option>
            <option value="AUTRE">Autre</option>
          </Select>
        </Field>
      </div>

      <Field label="Notes internes" hint="Non visibles sur les documents PDF">
        <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
      </Field>

      <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Enregistrement…" : "Enregistrer le client"}
        </Button>
      </div>
    </form>
  );
}
