import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import {
  AddressAutocomplete,
  revalidateAddressBeforeSubmit,
  type AddressValue,
} from "@/components/forms/AddressAutocomplete";
import {
  CompanyLookup,
  type CompanyLookupValue,
} from "@/components/forms/CompanyLookup";

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
  siren?: string | null;
  apeCode?: string | null;
  companyVerifiedAt?: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
  addressCityCode?: string | null;
  addressLat?: number | null;
  addressLon?: number | null;
  notes: string | null;
  hasAccessCode?: boolean;
  onboardingCompletedAt?: string | null;
  accessEmailSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastExchange?: {
    threadId: string;
    subject: string;
    lastMessageAt: string;
  } | null;
};

export type ClientFormData = {
  type: "B2B" | "B2C";
  firstName: string;
  lastName: string;
  companyName: string;
  email: string;
  phone: string;
  siret: string;
  siren: string;
  apeCode: string;
  companyVerifiedAt: string | null;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  addressCityCode: string;
  addressLat: number | null;
  addressLon: number | null;
  addressManualConfirmed: boolean;
  notes: string;
  sirenLocked: boolean;
};

export const emptyClientForm = (): ClientFormData => ({
  type: "B2C",
  firstName: "",
  lastName: "",
  companyName: "",
  email: "",
  phone: "",
  siret: "",
  siren: "",
  apeCode: "",
  companyVerifiedAt: null,
  addressLine1: "",
  addressLine2: "",
  postalCode: "",
  city: "",
  country: "FRANCE",
  addressCityCode: "",
  addressLat: null,
  addressLon: null,
  addressManualConfirmed: false,
  notes: "",
  sirenLocked: false,
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
    siren: c.siren ?? "",
    apeCode: c.apeCode ?? "",
    companyVerifiedAt: c.companyVerifiedAt ?? null,
    addressLine1: c.addressLine1 ?? "",
    addressLine2: c.addressLine2 ?? "",
    postalCode: c.postalCode ?? "",
    city: c.city ?? "",
    country: c.country ?? "FRANCE",
    addressCityCode: c.addressCityCode ?? "",
    addressLat: c.addressLat ?? null,
    addressLon: c.addressLon ?? null,
    addressManualConfirmed: false,
    notes: c.notes ?? "",
    sirenLocked: Boolean(c.companyVerifiedAt),
  };
}

function toAddressValue(form: ClientFormData): AddressValue {
  return {
    addressLine1: form.addressLine1,
    addressLine2: form.addressLine2,
    postalCode: form.postalCode,
    city: form.city,
    country: form.country,
    addressCityCode: form.addressCityCode,
    addressLat: form.addressLat,
    addressLon: form.addressLon,
    addressManualConfirmed: form.addressManualConfirmed,
  };
}

function toCompanyValue(form: ClientFormData): CompanyLookupValue {
  return {
    siren: form.siren,
    siret: form.siret,
    companyName: form.companyName,
    apeCode: form.apeCode,
    companyVerifiedAt: form.companyVerifiedAt,
    locked: form.sirenLocked,
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
  const [addressError, setAddressError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) setForm(initial);
  }, [initial]);

  function set<K extends keyof ClientFormData>(key: K, value: ClientFormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAddressError(null);
    try {
      const addrErr = await revalidateAddressBeforeSubmit(toAddressValue(form), (addr) => {
        setForm((f) => ({
          ...f,
          addressLine1: addr.addressLine1,
          addressLine2: addr.addressLine2,
          postalCode: addr.postalCode,
          city: addr.city,
          country: addr.country,
          addressCityCode: addr.addressCityCode,
          addressLat: addr.addressLat,
          addressLon: addr.addressLon,
          addressManualConfirmed: addr.addressManualConfirmed,
        }));
      });
      if (addrErr) {
        setAddressError(addrErr);
        toast.error(addrErr);
        return;
      }

      const payload = {
        type: form.type,
        firstName: form.firstName,
        lastName: form.lastName,
        companyName: form.companyName,
        email: form.email || null,
        phone: form.phone || null,
        siret: form.siret || null,
        siren: form.siren || null,
        apeCode: form.apeCode || null,
        companyVerifiedAt: form.companyVerifiedAt,
        addressLine1: form.addressLine1,
        addressLine2: form.addressLine2,
        postalCode: form.postalCode,
        city: form.city,
        country: form.country,
        addressCityCode: form.addressCityCode || null,
        addressLat: form.addressLat,
        addressLon: form.addressLon,
        addressManualConfirmed: form.addressManualConfirmed,
        notes: form.notes,
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
        <CompanyLookup
          value={toCompanyValue(form)}
          onChange={(c) =>
            setForm((f) => ({
              ...f,
              siren: c.siren,
              siret: c.siret,
              companyName: c.companyName,
              apeCode: c.apeCode,
              companyVerifiedAt: c.companyVerifiedAt,
              sirenLocked: c.locked,
            }))
          }
          onAddressPrefill={(addr) =>
            setForm((f) => ({
              ...f,
              addressLine1: addr.addressLine1,
              postalCode: addr.postalCode,
              city: addr.city,
              addressCityCode: addr.addressCityCode,
              addressLat: null,
              addressLon: null,
              addressManualConfirmed: false,
            }))
          }
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
      </div>

      <AddressAutocomplete
        value={toAddressValue(form)}
        onChange={(addr) =>
          setForm((f) => ({
            ...f,
            addressLine1: addr.addressLine1,
            addressLine2: addr.addressLine2,
            postalCode: addr.postalCode,
            city: addr.city,
            country: addr.country,
            addressCityCode: addr.addressCityCode,
            addressLat: addr.addressLat,
            addressLon: addr.addressLon,
            addressManualConfirmed: addr.addressManualConfirmed,
          }))
        }
      />
      {addressError ? <p className="text-sm text-[var(--danger)]">{addressError}</p> : null}

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
