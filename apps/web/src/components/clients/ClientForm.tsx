import { CLIENT_TYPE_LABEL, type ClientType } from "@/lib/client-type";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { fetchSettings } from "@/lib/settings-request";
import { Link } from "react-router-dom";
import { formatPhoneFr } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { ModalActions } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";
import { ServiceNeedsEditor, useNeedsCatalog, type ClientNeeds, type ServiceNeed } from "@/components/clients/ServiceNeedsEditor";
import {
  AddressAutocomplete,
  revalidateAddressBeforeSubmit,
  type AddressValue,
} from "@/components/forms/AddressAutocomplete";
import {
  CompanyLookup,
  type CompanyLookupValue,
} from "@/components/forms/CompanyLookup";
import { offlineEnabled } from "@/lib/offline/config";
import { submitCreation, useRequestId, type QueueItem } from "@/lib/offline/queue";
import { useReadOnly } from "@/lib/offline/read-only";
import { addressChanged } from "@/lib/address-compare";
import { VerifyEmailDialog } from "@/components/messaging/VerifyEmailDialog";

export type Client = {
  id: string;
  clientNumber?: string | null;
  type: ClientType;
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
  /** Jour de prélèvement par défaut de ses abonnements (1 à 28) ; null = le 1er. */
  billingDay?: number | null;
  /** Prestations souhaitées (liste et fiche) et leurs Précisions. */
  serviceNeeds?: ServiceNeed[];
  needsDetails?: string;
  emailVerifiedAt?: string | null;
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
  type: ClientType;
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
  /** "" = le 1er (valeur par défaut). */
  billingDay: string;
  sirenLocked: boolean;
};

/** Fiche préparée hors ligne (file de l'appareil), présentée comme un client en attente d'envoi. */
export function pendingClient(item: QueueItem): Client & { pending: true } {
  const body = item.body as Partial<Record<"type" | "firstName" | "lastName" | "companyName" | "email" | "phone" | "notes", string | null>>;
  return {
    id: item.clientId,
    clientNumber: null,
    type: (body.type as Client["type"]) ?? "B2C",
    displayName: item.clientName,
    firstName: body.firstName ?? null,
    lastName: body.lastName ?? null,
    companyName: body.companyName ?? null,
    email: body.email || null,
    phone: body.phone || null,
    siret: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    country: "FRANCE",
    notes: body.notes ?? null,
    createdAt: item.preparedAt,
    updatedAt: item.preparedAt,
    pending: true,
  };
}

/** Fiche proposée depuis un message du formulaire du site (bouton « Créer le client »). */
export type ClientPrefill = { name: string | null; email: string | null; phone: string | null; company: string | null };

export function prefillToForm(p: ClientPrefill): ClientFormData {
  const [firstName = "", ...rest] = (p.name ?? "").trim().split(/\s+/);
  return {
    ...emptyClientForm(),
    type: p.company ? "B2B" : "B2C",
    firstName,
    lastName: rest.join(" "),
    companyName: p.company ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
  };
}

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
  billingDay: "",
  sirenLocked: false,
});

export function clientToForm(c: Client): ClientFormData {
  return {
    type: c.type,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    companyName: c.companyName ?? "",
    email: c.email ?? "",
    phone: formatPhoneFr(c.phone),
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
    billingDay: c.billingDay ? String(c.billingDay) : "",
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
  const requestId = useRequestId();
  const [form, setForm] = useState<ClientFormData>(initial ?? emptyClientForm());
  // Hors ligne (origine du hors ligne) : fiche minimale mise en file, sans recherche d'adresse ni d'entreprise ;
  // rien ne part (ni e-mail d'accès ni Stripe) avant le retour du réseau.
  const { readOnly, canPrepare } = useReadOnly();
  const minimal = !clientId && readOnly && canPrepare;
  // Médiateur de la consommation déclaré ? (null tant que les réglages ne sont pas lus)
  const [hasMediator, setHasMediator] = useState<boolean | null>(null);
  useEffect(() => {
    fetchSettings<{ mediationClause?: string | null }>()
      .then((s) => setHasMediator(Boolean(s.mediationClause?.trim())))
      .catch(() => setHasMediator(null));
  }, []);
  const [busy, setBusy] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  // Création seulement : envoi de l'accès à l'espace client, coché par défaut.
  const [sendPortalAccess, setSendPortalAccess] = useState(true);
  // Client tout juste créé dont l'e-mail d'accès est à vérifier avant envoi.
  const [accessFor, setAccessFor] = useState<Client | null>(null);
  // Création seulement : besoins notés en rendez-vous (sur la fiche, bloc « Besoins » dédié).
  const [needs, setNeeds] = useState<ClientNeeds>({ services: [], details: "" });
  const needsPayload = { serviceNeeds: needs.services.map((n) => n.serviceId), needsDetails: needs.details };

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
      // Hors ligne : ni vérification d'adresse (service en ligne) ni adresse, SIRET ou accès à l'espace client.
      // « Modifier » : une adresse que la personne n'a pas touchée n'est pas revérifiée, donc jamais réécrite.
      if (!minimal && (!clientId || addressChanged(form, initial))) {
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
      }

      const payload = minimal
        ? {
            type: form.type,
            firstName: form.firstName,
            lastName: form.lastName,
            companyName: form.companyName,
            email: form.email || null,
            phone: form.phone || null,
            ...needsPayload,
            sendPortalAccess: false,
          }
        : {
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
            billingDay: form.billingDay ? Number(form.billingDay) : null,
            // Accès à l'espace client : jamais envoyé d'office à la création, relu dans « Vérifier l'e-mail » juste après.
            ...(clientId ? {} : { sendPortalAccess: false, ...needsPayload }),
          };
      type Saved = Client & { portalAccess?: { sent: boolean; reason?: string } | null };
      let client: Saved;
      if (!clientId && offlineEnabled()) {
        // Origine du hors ligne : envoi direct avec un clientRequestId, ou mise en file (hors ligne, réseau tombé).
        const name = form.type === "B2C" ? [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(" ") : form.companyName.trim();
        const result = await submitCreation<Saved>({ kind: "client", label: name, clientName: name, body: payload, requestId: requestId.current });
        requestId.renew();
        if (result.queued) {
          toast.success("Client préparé hors ligne : il sera créé au retour du réseau.");
          onSuccess(pendingClient(result.item));
          return;
        }
        client = result.data;
      } else {
        client = await api<Saved>(clientId ? `/api/clients/${clientId}` : "/api/clients", {
          method: clientId ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
      }
      if (!clientId) {
        toast.success(`Client créé (${client.clientNumber}).`);
        if (sendPortalAccess && form.email) {
          // La fiche se ferme une fois l'e-mail d'accès envoyé ou écarté.
          setAccessFor(client);
          return;
        }
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
    <>
    <form onSubmit={onSubmit} className="space-y-5">
      {minimal ? (
        <p role="note" data-offline-form className="rounded-[var(--radius-sm)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--text)]">
          Hors ligne : fiche minimale, créée au retour du réseau. Adresse, SIRET et accès à l&apos;espace client se
          complètent ensuite depuis la fiche.
        </p>
      ) : null}
      <div className="flex gap-2 rounded-[var(--radius)] bg-[var(--bg)] p-1">
        {(["B2C", "B2B", "ASSOCIATION"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={form.type === t}
            onClick={() => set("type", t)}
            className={`min-h-11 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
              form.type === t
                ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {CLIENT_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      {!initial && form.type === "B2C" && hasMediator === false ? (
        // Rappel non bloquant : la fiche se crée, mais aucun devis ne partira en signature sans médiateur.
        <p role="note" className="rounded-[var(--radius-sm)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--text)]">
          Un médiateur de la consommation est obligatoire pour signer avec un particulier (L612-1). Renseignez-le dans{" "}
          <Link to="/settings?tab=legal" className="font-medium text-[var(--primary)] underline underline-offset-2">
            Réglages &gt; Mentions légales
          </Link>
          .
        </p>
      ) : null}

      {form.type === "B2C" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Prénom">
            <Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
          </Field>
          <Field label="Nom" hint="Obligatoire">
            <Input required value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
          </Field>
        </div>
      ) : minimal ? (
        <Field label={form.type === "ASSOCIATION" ? "Nom de l'association" : "Raison sociale"} hint="Obligatoire">
          <Input required autoComplete="organization" value={form.companyName} onChange={(e) => set("companyName", e.target.value)} />
        </Field>
      ) : (
        <CompanyLookup
          nameLabel={form.type === "ASSOCIATION" ? "Nom de l'association" : "Raison sociale"}
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <Input
            value={form.phone}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
              const formatted =
                digits.length === 0
                  ? ""
                  : digits.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
              set("phone", formatted);
            }}
            inputMode="tel"
            autoComplete="tel"
            placeholder="06 12 34 56 78"
          />
        </Field>
      </div>

      {minimal ? null : (
      <FormSection title="Adresse" defaultOpen={Boolean(clientId || form.addressLine1 || addressError)}>
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
      </FormSection>
      )}

      {/* « Notes internes » : remplacées par le bloc-notes de la fiche (une seule source, chiffrée). */}
      {clientId ? null : (
        <FormSection title="Besoins" defaultOpen>
          <div className="space-y-1.5">
            <p className="text-xs text-[var(--muted)]">Pour préparer le devis et le projet.</p>
            <CreationNeeds value={needs} onChange={setNeeds} />
          </div>
        </FormSection>
      )}

      {minimal ? null : (
      <FormSection title="Abonnements" defaultOpen>
        <Field
          label="Jour de prélèvement"
          hint="Appliqué par défaut à tous ses abonnements (devis, nouvel abonnement). Chaque abonnement peut garder un autre jour. Les abonnements existants ne changent pas."
        >
          <Select value={form.billingDay} onChange={(e) => set("billingDay", e.target.value)}>
            <option value="">Le 1er du mois (par défaut)</option>
            {Array.from({ length: 27 }, (_, d) => d + 2).map((d) => (
              <option key={d} value={String(d)}>
                Le {d} du mois
              </option>
            ))}
          </Select>
        </Field>
      </FormSection>
      )}

      {clientId || minimal ? null : (
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={sendPortalAccess && Boolean(form.email)}
            disabled={!form.email}
            onChange={(e) => setSendPortalAccess(e.target.checked)}
          />
          <span>
            Envoyer l&apos;accès à l&apos;espace client
            <span className="block text-xs text-[var(--muted)]">
              {form.email
                ? "Un e-mail donne le lien de l'espace client et explique la connexion par code. Vous le relisez avant l'envoi."
                : "Renseignez une adresse e-mail pour envoyer l'accès."}
            </span>
          </span>
        </label>
      )}

      <ModalActions>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Enregistrement…" : clientId ? "Enregistrer le client" : minimal ? "Préparer le client" : "Créer le client"}
        </Button>
      </ModalActions>
    </form>
    {accessFor ? (
      <VerifyEmailDialog
        open
        title="Vérifier l'e-mail : accès à l'espace client"
        draftUrl={`/api/clients/${accessFor.id}/portal/welcome/draft`}
        onClose={() => {
          const created = accessFor;
          setAccessFor(null);
          onSuccess(created);
        }}
        onSend={async (edits) => {
          const r = await api<{ sent: boolean; reason?: string }>(`/api/clients/${accessFor.id}/portal/welcome`, {
            method: "POST",
            body: JSON.stringify(edits),
          }).catch((e: unknown) => {
            toast.error(e instanceof Error ? e.message : "Envoi impossible");
            return null;
          });
          if (!r) return;
          if (r.sent) toast.success("Accès à l'espace client envoyé par e-mail.");
          else if (r.reason === "smtp_off") toast.warning("SMTP non configuré : accès non envoyé.");
          else toast.warning("L'e-mail d'accès n'a pas pu partir.");
          const created = accessFor;
          setAccessFor(null);
          onSuccess(created);
        }}
      />
    ) : null}
    </>
  );
}

/** Section repliable du formulaire client (mobile : on ne déroule que ce qu'on remplit). */
function FormSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-[var(--radius)] border border-[var(--border)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-semibold">
        {title}
        <FontAwesomeIcon
          icon={faChevronDown}
          aria-hidden
          className="h-3 w-3 text-[var(--muted)] transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="space-y-4 border-t border-[var(--border)] p-3">{children}</div>
    </details>
  );
}

/** Besoins à la création : le catalogue n'est lu que si le formulaire crée une fiche. */
function CreationNeeds({ value, onChange }: { value: ClientNeeds; onChange: (next: ClientNeeds) => void }) {
  const { catalog, error } = useNeedsCatalog();
  return <ServiceNeedsEditor value={value} onChange={onChange} catalog={catalog} catalogError={error} />;
}
