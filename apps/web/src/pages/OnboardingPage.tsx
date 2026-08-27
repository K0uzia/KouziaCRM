import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";

type OnboardingView = {
  emailMasked: string;
  existingClientId: string | null;
  existingType: "B2B" | "B2C" | null;
  displayName: string | null;
  completedAt: string | null;
};

type FormState = {
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

const emptyForm = (): FormState => ({
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

export function OnboardingPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<OnboardingView | null>(null);
  const [status, setStatus] = useState<"loading" | "invalid" | "ready" | "done" | "error">(
    "loading",
  );
  const [form, setForm] = useState<FormState>(emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/onboarding/${token}`, { method: "GET" });
        if (!res.ok) {
          if (!cancelled) setStatus("invalid");
          return;
        }
        const body = (await res.json()) as OnboardingView;
        if (cancelled) return;
        setView(body);
        setForm((f) => ({
          ...f,
          type: body.existingType ?? "B2C",
          email: "",
        }));
        setStatus(body.completedAt ? "done" : "ready");
      } catch {
        if (!cancelled) setStatus("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/public/onboarding/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          email: form.email || null,
          phone: form.phone || null,
          siret: form.siret || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (typeof body.error === "string") {
          throw new Error(body.error);
        }
        // Erreur de validation zod : { formErrors: [], fieldErrors: { champ: [msg] } }
        if (body.error && typeof body.error === "object" && body.error.fieldErrors) {
          const fe = body.error.fieldErrors as Record<string, string[]>;
          const map: Record<string, string> = {};
          for (const [k, v] of Object.entries(fe)) {
            if (Array.isArray(v) && v.length > 0) map[k] = v[0];
          }
          setFieldErrors(map);
          const all = Object.values(map);
          if (all.length > 0) throw new Error(all.join(" · "));
        }
        throw new Error("Une erreur est survenue. Veuillez vérifier les champs en rouge.");
      }
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") {
    return <Shell>Chargement du formulaire...</Shell>;
  }

  if (status === "invalid") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Lien invalide ou expiré</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Ce lien n&apos;est plus valide. Contactez votre prestataire pour en recevoir un nouveau.
        </p>
      </Shell>
    );
  }

  if (status === "done") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Merci, c&apos;est enregistré !</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Vos informations ont bien été transmises. Votre prestataire reviendra vers vous si besoin.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold">Complétez votre fiche client</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {view?.displayName ? `Bonjour ${view.displayName},` : "Bonjour,"} merci de renseigner les
        informations ci-dessous. Elles sont chiffrées et stockées de façon sécurisée.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <div className="flex gap-2 rounded-[var(--radius)] bg-[var(--bg)] p-1">
          {(["B2C", "B2B"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => set("type", t)}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${
                form.type === t
                  ? "bg-white text-[var(--text)] shadow-sm"
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
            <Field label="Nom" hint="Obligatoire" error={fieldErrors.lastName}>
              <Input required value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Raison sociale"
              hint="Obligatoire"
              error={fieldErrors.companyName}
              className="sm:col-span-2"
            >
              <Input
                required
                value={form.companyName}
                onChange={(e) => set("companyName", e.target.value)}
              />
            </Field>
            <Field label="SIRET" hint="14 chiffres" error={fieldErrors.siret}>
              <Input
                value={form.siret}
                onChange={(e) => set("siret", e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Email"
            hint={view?.emailMasked ? `Associé au lien : ${view.emailMasked}` : undefined}
          >
            <Input type="email" value={view?.emailMasked ?? ""} readOnly disabled />
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

        <Field
          label="Informations complémentaires"
          hint="Tout élément utile pour la facturation (N° TVA intracom., référence interne, etc.)"
        >
          <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
        </Field>

        {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Enregistrement..." : "Transmettre mes informations"}
        </Button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-12">
      <div className="mx-auto max-w-lg">
        <p className="text-2xl font-semibold tracking-tight text-[var(--primary)]">Kouzia</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
