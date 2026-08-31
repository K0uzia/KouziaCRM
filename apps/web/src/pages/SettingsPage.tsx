import { useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";

type Settings = {
  id: string;
  legalName: string;
  tradeName: string | null;
  siren: string;
  siret: string;
  apeCode: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  country: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  vatMention: string;
  urssafPeriodicity: string;
  treasuryRateBps: number;
  placementRateBps: number;
  reminderQuoteDays: number;
  reminderInvoiceDays: number;
  publicTrackingShowAmounts: boolean;
  businessStartDate: string | null;
  rneRegistrationDate: string | null;
  lastIncomeTaxDeclaredYear: number | null;
  cfeAmountCents: number;
  bankIban: string | null;
  bankBic: string | null;
  bankAccountHolder: string | null;
  bankName: string | null;
  b2cActivity: boolean;
  incomeTaxReminderMonth: number;
  incomeTaxReminderDay: number;
  inpiUrl: string | null;
  invoiceNumberTemplate: string;
  quoteNumberTemplate: string;
  creditNoteNumberTemplate: string;
  numberCounterWidth: number;
};

type SmtpStatus = {
  configured: boolean;
  source: "db" | "env" | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
};

type NumberingPreview = {
  series: string;
  year: number;
  lastValue: number;
  nextValue: number;
  nextPreview: string;
  template: string;
};

type NumberingAudit = {
  ok: boolean;
  generatedAt: string;
  series: Array<{
    series: string;
    year: number;
    counterLastValue: number | null;
    issuedCount: number;
    maxSequence: number | null;
    holes: number[];
    duplicates: Array<{ value: number; numbers: string[]; count: number }>;
    ok: boolean;
  }>;
};

type Checklist = {
  id: string;
  urssafAccount: boolean;
  impotsProAccount: boolean;
  activityQuestionnaire: boolean;
  cfeInitialDeclaration: boolean;
  rcpInsurance: boolean;
  mediationChecked: boolean;
  dedicatedBankAccount: boolean;
};

type LegalClause = {
  id: string;
  kind: string;
  title: string;
  body: string;
  required: boolean;
  active: boolean;
  position: number;
};

const CHECKLIST_LABELS: Array<{ key: keyof Omit<Checklist, "id">; label: string }> = [
  { key: "urssafAccount", label: "Compte autoentrepreneur.urssaf.fr" },
  { key: "impotsProAccount", label: "Espace impots.gouv professionnel" },
  { key: "activityQuestionnaire", label: "Questionnaire d'activité (30 j)" },
  { key: "cfeInitialDeclaration", label: "Déclaration initiale CFE" },
  { key: "rcpInsurance", label: "RCP souscrite" },
  { key: "mediationChecked", label: "Médiation conso vérifiée (B2C)" },
  { key: "dedicatedBankAccount", label: "Compte bancaire dédié pro" },
];

function settingsFingerprint(s: Settings): string {
  return JSON.stringify(s);
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [clauses, setClauses] = useState<LegalClause[]>([]);
  const [busy, setBusy] = useState(false);
  const [inpiQuery, setInpiQuery] = useState("");
  const [clauseModal, setClauseModal] = useState<LegalClause | "new" | null>(null);
  const [clauseForm, setClauseForm] = useState({ title: "", body: "", kind: "CUSTOM" });
  const [previews, setPreviews] = useState<NumberingPreview[]>([]);
  const [audit, setAudit] = useState<NumberingAudit | null>(null);
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [smtpForm, setSmtpForm] = useState({
    host: "",
    port: "587",
    secure: false,
    user: "",
    pass: "",
    from: "",
  });
  const [smtpBusy, setSmtpBusy] = useState(false);
  const savedFingerprint = useRef<string | null>(null);
  const smtpSavedFingerprint = useRef<string | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const smtpFormRef = useRef(smtpForm);
  const savingSettings = useRef(false);
  const savingSmtp = useRef(false);

  settingsRef.current = settings;
  smtpFormRef.current = smtpForm;

  function applySettings(next: Settings, markSaved: boolean) {
    setSettings(next);
    if (markSaved) {
      savedFingerprint.current = settingsFingerprint(next);
    }
  }

  function isSettingsDirty(next = settingsRef.current): boolean {
    if (!next || savedFingerprint.current === null) return false;
    return settingsFingerprint(next) !== savedFingerprint.current;
  }

  function settingsBlurHandlers(): Pick<InputHTMLAttributes<HTMLInputElement>, "onBlur" | "onKeyDown"> {
    return {
      onBlur: () => {
        void flushSettingsSave();
      },
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      },
    };
  }

  async function flushSettingsSave() {
    const current = settingsRef.current;
    if (!current || savingSettings.current || !isSettingsDirty(current)) return;
    await persistSettings(current);
  }

  function patchSettingsAndSave(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    void persistSettings(next);
  }

  function smtpFingerprint(form: typeof smtpForm): string {
    return JSON.stringify(form);
  }

  function smtpBlurHandlers(): Pick<InputHTMLAttributes<HTMLInputElement>, "onBlur" | "onKeyDown"> {
    return {
      onBlur: () => {
        void flushSmtpSave();
      },
      onKeyDown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      },
    };
  }

  async function flushSmtpSave() {
    const form = smtpFormRef.current;
    if (savingSmtp.current) return;
    if (smtpSavedFingerprint.current === null) return;
    if (smtpFingerprint(form) === smtpSavedFingerprint.current) return;
    await persistSmtp(form);
  }

  async function load() {
    const [s, c, cl, prev, smtpStatus] = await Promise.all([
      api<Settings>("/api/settings"),
      api<Checklist>("/api/checklist"),
      api<LegalClause[]>("/api/legal-clauses"),
      api<{ previews: NumberingPreview[] }>("/api/numbering/preview"),
      api<SmtpStatus>("/api/settings/smtp").catch(() => null),
    ]);
    applySettings(s, true);
    setChecklist(c);
    setClauses(cl);
    setPreviews(prev.previews);
    setInpiQuery(s.inpiUrl || s.siren || "");
    if (smtpStatus) {
      setSmtp(smtpStatus);
      const loaded = {
        host: smtpStatus.host ?? "",
        port: String(smtpStatus.port ?? 587),
        secure: smtpStatus.secure,
        user: smtpStatus.user ?? "",
        pass: "",
        from: smtpStatus.from ?? "",
      };
      setSmtpForm(loaded);
      smtpSavedFingerprint.current = smtpFingerprint(loaded);
    } else {
      smtpSavedFingerprint.current = smtpFingerprint(smtpFormRef.current);
    }
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  async function persistSettings(next: Settings) {
    if (savingSettings.current) return;
    savingSettings.current = true;
    setBusy(true);
    const payloadFingerprint = settingsFingerprint(next);
    try {
      const updated = await api<Settings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          legalName: next.legalName,
          tradeName: next.tradeName,
          siren: next.siren,
          siret: next.siret,
          apeCode: next.apeCode,
          addressLine1: next.addressLine1,
          addressLine2: next.addressLine2,
          postalCode: next.postalCode,
          city: next.city,
          country: next.country,
          email: next.email,
          phone: next.phone,
          website: next.website,
          urssafPeriodicity: next.urssafPeriodicity,
          treasuryRateBps: next.treasuryRateBps,
          placementRateBps: next.placementRateBps,
          reminderQuoteDays: next.reminderQuoteDays,
          reminderInvoiceDays: next.reminderInvoiceDays,
          publicTrackingShowAmounts: next.publicTrackingShowAmounts,
          businessStartDate: next.businessStartDate
            ? next.businessStartDate.slice(0, 10)
            : null,
          rneRegistrationDate: next.rneRegistrationDate
            ? next.rneRegistrationDate.slice(0, 10)
            : null,
          lastIncomeTaxDeclaredYear: next.lastIncomeTaxDeclaredYear,
          cfeAmountCents: next.cfeAmountCents,
          bankIban: next.bankIban,
          bankBic: next.bankBic,
          bankAccountHolder: next.bankAccountHolder,
          bankName: next.bankName,
          b2cActivity: next.b2cActivity,
          incomeTaxReminderMonth: next.incomeTaxReminderMonth,
          incomeTaxReminderDay: next.incomeTaxReminderDay,
          inpiUrl: next.inpiUrl,
          invoiceNumberTemplate: next.invoiceNumberTemplate,
          quoteNumberTemplate: next.quoteNumberTemplate,
          creditNoteNumberTemplate: next.creditNoteNumberTemplate,
          numberCounterWidth: next.numberCounterWidth,
        }),
      });
      setSettings((prev) => (prev ? { ...prev, ...updated } : updated));
      savedFingerprint.current = payloadFingerprint;
      const prev = await api<{ previews: NumberingPreview[] }>("/api/numbering/preview");
      setPreviews(prev.previews);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      savingSettings.current = false;
      setBusy(false);
    }
  }

  async function persistSmtp(form: typeof smtpForm) {
    if (savingSmtp.current) return;
    savingSmtp.current = true;
    setSmtpBusy(true);
    try {
      const status = await api<SmtpStatus>("/api/settings/smtp", {
        method: "PATCH",
        body: JSON.stringify({
          host: form.host || null,
          port: Number(form.port) || 587,
          secure: form.secure,
          user: form.user || null,
          pass: form.pass || null,
          from: form.from || null,
          keepPassword: !form.pass,
        }),
      });
      setSmtp(status);
      const cleared = { ...form, pass: "" };
      setSmtpForm(cleared);
      smtpSavedFingerprint.current = smtpFingerprint(cleared);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur SMTP");
    } finally {
      savingSmtp.current = false;
      setSmtpBusy(false);
    }
  }

  async function testSmtp() {
    setSmtpBusy(true);
    try {
      await api("/api/settings/smtp/test", { method: "POST", body: "{}" });
      toast.success("Email de test envoyé (vérifiez votre boîte / Mailpit)");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec du test");
    } finally {
      setSmtpBusy(false);
    }
  }

  async function importInpi() {
    setBusy(true);
    try {
      const res = await api<{
        settings: Settings;
        import: { warnings: string[]; redacted: boolean };
      }>("/api/settings/import-inpi", {
        method: "POST",
        body: JSON.stringify({ query: inpiQuery }),
      });
      applySettings(res.settings, true);
      for (const w of res.import.warnings) toast.message(w);
      toast.success("Identité mise à jour depuis l'open data / INPI");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import impossible");
    } finally {
      setBusy(false);
    }
  }

  async function runAudit() {
    try {
      setAudit(await api<NumberingAudit>("/api/numbering/audit"));
      toast.success("Audit terminé");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Audit impossible");
    }
  }

  async function reseedNumbering() {
    try {
      await api("/api/settings/numbering/reseed", { method: "POST", body: "{}" });
      const prev = await api<{ previews: NumberingPreview[] }>("/api/numbering/preview");
      setPreviews(prev.previews);
      toast.success("Compteurs recalculés depuis les documents émis");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reseed impossible");
    }
  }

  async function toggleChecklist(key: keyof Omit<Checklist, "id">, value: boolean) {
    if (!checklist) return;
    try {
      setChecklist(await api("/api/checklist", { method: "PATCH", body: JSON.stringify({ [key]: value }) }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  async function saveClause(e: FormEvent) {
    e.preventDefault();
    try {
      if (clauseModal === "new") {
        await api("/api/legal-clauses", {
          method: "POST",
          body: JSON.stringify(clauseForm),
        });
        toast.success("Clause ajoutée");
      } else if (clauseModal) {
        await api(`/api/legal-clauses/${clauseModal.id}`, {
          method: "PUT",
          body: JSON.stringify({
            title: clauseForm.title,
            body: clauseForm.body,
            kind: clauseForm.kind,
            active: clauseModal.active,
          }),
        });
        toast.success("Clause mise à jour");
      }
      setClauseModal(null);
      setClauses(await api("/api/legal-clauses"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    }
  }

  async function deleteClause(id: string) {
    try {
      await api(`/api/legal-clauses/${id}`, { method: "DELETE" });
      setClauses(await api("/api/legal-clauses"));
      toast.success("Clause supprimée");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  if (!settings) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  function SettingsInput({ onBlur, onKeyDown, ...props }: InputHTMLAttributes<HTMLInputElement>) {
    const handlers = settingsBlurHandlers();
    return (
      <Input
        {...props}
        onBlur={(e) => {
          handlers.onBlur?.(e);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          handlers.onKeyDown?.(e);
          onKeyDown?.(e);
        }}
      />
    );
  }

  function SmtpInput({ onBlur, onKeyDown, ...props }: InputHTMLAttributes<HTMLInputElement>) {
    const handlers = smtpBlurHandlers();
    return (
      <Input
        {...props}
        onBlur={(e) => {
          handlers.onBlur?.(e);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          handlers.onKeyDown?.(e);
          onKeyDown?.(e);
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Réglages"
        subtitle="Mon entreprise, mes déclarations, mes documents"
        actions={
          busy || smtpBusy ? (
            <span className="text-xs text-[var(--muted)]">Enregistrement…</span>
          ) : null
        }
      />

      <div className="space-y-8">
        {/* 1. Identité */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Mon entreprise</h2>
          <Card className="space-y-4 border border-[var(--border)] p-5">
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-[240px] flex-1"
                placeholder="SIREN ou URL data.inpi.fr/entreprises/…"
                value={inpiQuery}
                onChange={(e) => setInpiQuery(e.target.value)}
              />
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void importInpi()}>
                Importer INPI / open data
              </Button>
            </div>
            <p className="text-xs text-[var(--muted)]">
              Récupère SIREN, SIRET, APE, dates. Les EI en diffusion partielle gardent l&apos;adresse déjà saisie.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom légal">
                <SettingsInput
                  required
                  value={settings.legalName}
                  onChange={(e) => setSettings({ ...settings, legalName: e.target.value })}
                />
              </Field>
              <Field label="Nom commercial">
                <SettingsInput
                  value={settings.tradeName ?? ""}
                  onChange={(e) => setSettings({ ...settings, tradeName: e.target.value || null })}
                />
              </Field>
              <Field label="SIREN">
                <SettingsInput
                  required
                  value={settings.siren}
                  onChange={(e) => setSettings({ ...settings, siren: e.target.value })}
                />
              </Field>
              <Field label="SIRET">
                <SettingsInput
                  required
                  value={settings.siret}
                  onChange={(e) => setSettings({ ...settings, siret: e.target.value })}
                />
              </Field>
              <Field label="APE">
                <SettingsInput
                  required
                  value={settings.apeCode}
                  onChange={(e) => setSettings({ ...settings, apeCode: e.target.value })}
                />
              </Field>
              <Field label="Immatriculation RNE">
                <SettingsInput
                  type="date"
                  value={settings.rneRegistrationDate?.slice(0, 10) ?? ""}
                  onChange={(e) =>
                    setSettings({ ...settings, rneRegistrationDate: e.target.value || null })
                  }
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Date d&apos;immatriculation au registre (INPI). Remplie automatiquement à
                  l&apos;import open data.
                </p>
              </Field>
              <Field label="Début d'activité">
                <SettingsInput
                  type="date"
                  value={settings.businessStartDate?.slice(0, 10) ?? ""}
                  onChange={(e) =>
                    setSettings({ ...settings, businessStartDate: e.target.value || null })
                  }
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Date réelle de début d&apos;activité (souvent = 1er jour facturé). Utilisée pour
                  CFE, URSSAF et réserves. Import INPI : champ « début d&apos;activité » du siège.
                </p>
              </Field>
              <Field label="Adresse" className="sm:col-span-2">
                <SettingsInput
                  required
                  value={settings.addressLine1}
                  onChange={(e) => setSettings({ ...settings, addressLine1: e.target.value })}
                />
              </Field>
              <Field label="Code postal">
                <SettingsInput
                  required
                  value={settings.postalCode}
                  onChange={(e) => setSettings({ ...settings, postalCode: e.target.value })}
                />
              </Field>
              <Field label="Ville">
                <SettingsInput
                  required
                  value={settings.city}
                  onChange={(e) => setSettings({ ...settings, city: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <SettingsInput
                  type="email"
                  value={settings.email ?? ""}
                  onChange={(e) => setSettings({ ...settings, email: e.target.value || null })}
                />
              </Field>
              <Field label="Téléphone">
                <SettingsInput
                  value={settings.phone ?? ""}
                  onChange={(e) => setSettings({ ...settings, phone: e.target.value || null })}
                />
              </Field>
            </div>
            <p className="text-xs text-[var(--muted)]">Mention TVA : {settings.vatMention}</p>
          </Card>
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Coordonnées bancaires (encaissement)</h2>
          <Card className="grid gap-4 border border-[var(--border)] p-5 sm:grid-cols-2">
            <p className="text-xs text-[var(--muted)] sm:col-span-2">
              Affichées sur les factures PDF et le suivi client pour que vos clients puissent vous
              régler par virement. Utilisez l&apos;IBAN de votre compte Revolut Business (ou autre
              compte pro).
            </p>
            <Field label="Titulaire">
              <SettingsInput
                placeholder="Alexandre Kouziaeff"
                value={settings.bankAccountHolder ?? ""}
                onChange={(e) =>
                  setSettings({ ...settings, bankAccountHolder: e.target.value || null })
                }
              />
            </Field>
            <Field label="Banque">
              <SettingsInput
                placeholder="Revolut"
                value={settings.bankName ?? ""}
                onChange={(e) => setSettings({ ...settings, bankName: e.target.value || null })}
              />
            </Field>
            <Field label="IBAN">
              <SettingsInput
                placeholder="FR76 …"
                value={settings.bankIban ?? ""}
                onChange={(e) => setSettings({ ...settings, bankIban: e.target.value || null })}
              />
            </Field>
            <Field label="BIC">
              <SettingsInput
                placeholder="REVOFRP2"
                value={settings.bankBic ?? ""}
                onChange={(e) => setSettings({ ...settings, bankBic: e.target.value || null })}
              />
            </Field>
          </Card>
        </section>

        {/* 2. Obligations */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Déclarations et cotisations</h2>
          <Card className="space-y-4 border border-[var(--border)] p-5">
            <p className="text-xs text-[var(--muted)]">
              URSSAF : avant le <strong>15</strong> du mois suivant (ou du mois suivant la fin de
              trimestre). CFE : avant le <strong>15 décembre</strong> de l&apos;année en cours.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Périodicité URSSAF">
                <Select
                  value={settings.urssafPeriodicity}
                  onChange={(e) => patchSettingsAndSave({ urssafPeriodicity: e.target.value })}
                >
                  <option value="MONTHLY">Mensuelle</option>
                  <option value="QUARTERLY">Trimestrielle</option>
                </Select>
              </Field>
              <Field label="Montant CFE (€)">
                <SettingsInput
                  type="number"
                  step="0.01"
                  min={0}
                  value={(settings.cfeAmountCents / 100).toFixed(2)}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      cfeAmountCents: Math.round(Number(e.target.value) * 100),
                    })
                  }
                />
              </Field>
              <Field label="Rappel impôts (jj/mm)">
                <div className="flex gap-2">
                  <SettingsInput
                    type="number"
                    min={1}
                    max={28}
                    value={settings.incomeTaxReminderDay}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        incomeTaxReminderDay: Number(e.target.value),
                      })
                    }
                  />
                  <SettingsInput
                    type="number"
                    min={1}
                    max={12}
                    value={settings.incomeTaxReminderMonth}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        incomeTaxReminderMonth: Number(e.target.value),
                      })
                    }
                  />
                </div>
              </Field>
              <Field label="Revenus déjà déclarés (année des revenus)">
                <SettingsInput
                  type="number"
                  min={2000}
                  max={2100}
                  placeholder="2025"
                  value={settings.lastIncomeTaxDeclaredYear ?? ""}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      lastIncomeTaxDeclaredYear: e.target.value
                        ? Number(e.target.value)
                        : null,
                    })
                  }
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Année des revenus déjà déclarés (ex. 2025 si déclaré en 2026). Prochaine échéance :
                  revenus {new Date().getFullYear()} à déclarer en {new Date().getFullYear() + 1}.
                </p>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.b2cActivity}
                onChange={(e) => patchSettingsAndSave({ b2cActivity: e.target.checked })}
              />
              Je facture des particuliers (rappel médiation)
            </label>
            {checklist ? (
              <div className="border-t border-[var(--border)] pt-4">
                <p className="mb-2 text-sm font-medium">Checklist post-création</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {CHECKLIST_LABELS.map(({ key, label }) => (
                    <li key={key}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checklist[key]}
                          onChange={(e) => void toggleChecklist(key, e.target.checked)}
                        />
                        {label}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </section>

        {/* 3. Numérotation */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Numérotation des documents</h2>
          <Card className="space-y-4 border border-[var(--border)] p-5">
            <p className="text-xs text-[var(--muted)]">
              Variables : {"{prefix}"}, {"{year}"}, {"{counter}"}. Attribution uniquement à
              l&apos;émission. Séries distinctes : factures (dont acomptes), devis, avoirs.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Template factures">
                <SettingsInput
                  value={settings.invoiceNumberTemplate}
                  onChange={(e) =>
                    setSettings({ ...settings, invoiceNumberTemplate: e.target.value })
                  }
                />
              </Field>
              <Field label="Template devis">
                <SettingsInput
                  value={settings.quoteNumberTemplate}
                  onChange={(e) =>
                    setSettings({ ...settings, quoteNumberTemplate: e.target.value })
                  }
                />
              </Field>
              <Field label="Template avoirs">
                <SettingsInput
                  value={settings.creditNoteNumberTemplate}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      creditNoteNumberTemplate: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="Largeur compteur">
                <SettingsInput
                  type="number"
                  min={1}
                  max={8}
                  value={settings.numberCounterWidth}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      numberCounterWidth: Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {previews.map((p) => (
                <div
                  key={`${p.series}-${p.year}`}
                  className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                >
                  <p className="text-xs text-[var(--muted)]">
                    {p.series} · {p.year}
                  </p>
                  <p className="mt-1 font-mono text-sm font-medium">{p.nextPreview}</p>
                  <p className="text-[10px] text-[var(--muted)]">prochain numéro</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => void runAudit()}>
                Audit d&apos;intégrité
              </Button>
              <Button type="button" variant="secondary" onClick={() => void reseedNumbering()}>
                Reseed compteurs
              </Button>
            </div>
            {audit ? (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  audit.ok
                    ? "border-[var(--success)]/30 bg-[var(--success-soft)] text-[var(--success)]"
                    : "border-[var(--danger)]/30 bg-[var(--danger-soft)] text-[var(--danger)]"
                }`}
              >
                <p className="font-medium">
                  {audit.ok
                    ? "Séries continues : aucun trou ni doublon"
                    : "Anomalies détectées"}
                </p>
                <ul className="mt-1 space-y-1">
                  {audit.series.map((s) => (
                    <li key={`${s.series}-${s.year}`}>
                      {s.series} {s.year} : {s.issuedCount} doc(s)
                      {s.holes.length ? ` · trous [${s.holes.join(", ")}]` : ""}
                      {s.duplicates.length
                        ? ` · doublons ${s.duplicates.map((d) => d.value).join(", ")}`
                        : ""}
                      {s.ok ? " · OK" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </section>

        {/* 4. Conditions légales */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Conditions générales (PDF)</h2>
            <Button
              type="button"
              variant="secondary"
              className="h-8 px-3 text-xs"
              onClick={() => {
                setClauseForm({ title: "", body: "", kind: "CUSTOM" });
                setClauseModal("new");
              }}
            >
              Ajouter
            </Button>
          </div>
          <Card className="divide-y divide-[var(--border)] border border-[var(--border)]">
            {clauses.map((c) => (
              <div key={c.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {c.title}
                    {c.required ? (
                      <span className="ml-2 text-xs text-[var(--muted)]">obligatoire</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted)] whitespace-pre-wrap">{c.body}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 px-2 text-xs"
                    onClick={() => {
                      setClauseForm({ title: c.title, body: c.body, kind: c.kind });
                      setClauseModal(c);
                    }}
                  >
                    Modifier
                  </Button>
                  {!c.required ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 px-2 text-xs text-[var(--danger)]"
                      onClick={() => void deleteClause(c.id)}
                    >
                      Supprimer
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </Card>
        </section>

        {/* 5. Trésorerie & divers */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Trésorerie et relances</h2>
          <Card className="grid gap-4 border border-[var(--border)] p-5 sm:grid-cols-2">
            <Field label="Enveloppe trésorerie entreprise (bps)" hint="Part des encaissements à garder sur le compte pro (hors URSSAF et placements). 1420 = 14,2 %">
              <SettingsInput
                type="number"
                value={settings.treasuryRateBps}
                onChange={(e) =>
                  setSettings({ ...settings, treasuryRateBps: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Enveloppe placements (bps)">
              <SettingsInput
                type="number"
                value={settings.placementRateBps}
                onChange={(e) =>
                  setSettings({ ...settings, placementRateBps: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Relance devis (j)">
              <SettingsInput
                type="number"
                value={settings.reminderQuoteDays}
                onChange={(e) =>
                  setSettings({ ...settings, reminderQuoteDays: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Relance facture (j)">
              <SettingsInput
                type="number"
                value={settings.reminderInvoiceDays}
                onChange={(e) =>
                  setSettings({ ...settings, reminderInvoiceDays: Number(e.target.value) })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={settings.publicTrackingShowAmounts}
                onChange={(e) =>
                  patchSettingsAndSave({ publicTrackingShowAmounts: e.target.checked })
                }
              />
              Afficher les montants sur le suivi public client
            </label>
          </Card>
        </section>

        <section className="space-y-4">
          <h2 className="text-base font-semibold">Envoi d&apos;emails (SMTP)</h2>
          <Card className="space-y-4 border border-[var(--border)] p-5">
            <p className="text-xs text-[var(--muted)]">
              {smtp?.configured
                ? `SMTP actif (source : ${smtp.source === "db" ? "paramètres" : "fichier .env"})`
                : "SMTP non configuré. Les emails ne partiront pas tant que ces champs (ou le .env) ne sont pas renseignés."}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Hôte">
                <SmtpInput
                  placeholder="127.0.0.1 ou smtp.exemple.fr"
                  value={smtpForm.host}
                  onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })}
                />
              </Field>
              <Field label="Port">
                <SmtpInput
                  type="number"
                  value={smtpForm.port}
                  onChange={(e) => setSmtpForm({ ...smtpForm, port: e.target.value })}
                />
              </Field>
              <Field label="Utilisateur">
                <SmtpInput
                  value={smtpForm.user}
                  onChange={(e) => setSmtpForm({ ...smtpForm, user: e.target.value })}
                />
              </Field>
              <Field label="Mot de passe">
                <SmtpInput
                  type="password"
                  placeholder={smtp?.hasPassword ? "•••••••• (inchangé si vide)" : ""}
                  value={smtpForm.pass}
                  onChange={(e) => setSmtpForm({ ...smtpForm, pass: e.target.value })}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Expéditeur (From)" className="sm:col-span-2">
                <SmtpInput
                  placeholder='Kouzia <contact@exemple.fr>'
                  value={smtpForm.from}
                  onChange={(e) => setSmtpForm({ ...smtpForm, from: e.target.value })}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={smtpForm.secure}
                onChange={(e) => {
                  const next = { ...smtpForm, secure: e.target.checked };
                  setSmtpForm(next);
                  void persistSmtp(next);
                }}
              />
              Connexion sécurisée (TLS / port 465)
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={smtpBusy}
                onClick={() => void testSmtp()}
              >
                Envoyer un email de test
              </Button>
            </div>
          </Card>
        </section>
      </div>

      <PayoutBeneficiaryCard />

      <Modal
        open={clauseModal !== null}
        onClose={() => setClauseModal(null)}
        title={clauseModal === "new" ? "Nouvelle clause" : "Modifier la clause"}
      >
        <form onSubmit={saveClause} className="space-y-4">
          <Field label="Titre">
            <Input
              required
              value={clauseForm.title}
              onChange={(e) => setClauseForm({ ...clauseForm, title: e.target.value })}
            />
          </Field>
          <Field label="Texte">
            <Textarea
              required
              rows={4}
              value={clauseForm.body}
              onChange={(e) => setClauseForm({ ...clauseForm, body: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setClauseModal(null)}>
              Annuler
            </Button>
            <Button type="submit">Enregistrer</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

type PayoutStatus = {
  enabled: boolean;
  hasBeneficiary: boolean;
  beneficiaryLabel: string | null;
};

/**
 * Compte personnel vers lequel le virement de rémunération est préparé.
 * L'IBAN est chiffré en base et jamais renvoyé : on ne peut que le remplacer.
 */
function PayoutBeneficiaryCard() {
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const [label, setLabel] = useState("Compte personnel");
  const [name, setName] = useState("");
  const [iban, setIban] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setStatus(await api<PayoutStatus>("/api/payouts/status"));
  }

  useEffect(() => {
    load().catch(() => setStatus(null));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    const cleanIban = iban.replace(/\s+/g, "").toUpperCase();
    if (cleanIban.length < 15) {
      toast.error("IBAN trop court");
      return;
    }
    setBusy(true);
    try {
      await api("/api/payouts/beneficiary", {
        method: "PUT",
        body: JSON.stringify({ label: label.trim(), name: name.trim(), iban: cleanIban }),
      });
      toast.success("Compte enregistré");
      setName("");
      setIban("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <section className="mt-8 space-y-4">
      <h2 className="text-base font-semibold">Virement de rémunération</h2>
      <Card className="space-y-4 border border-[var(--border)] p-5">
        <p className="text-sm text-[var(--muted)]">
          {status.hasBeneficiary
            ? `Compte enregistré : ${status.beneficiaryLabel}. Le titulaire et l'IBAN sont chiffrés, ils ne peuvent qu'être remplacés.`
            : "Aucun compte enregistré. Remplissez le formulaire ci-dessous puis cliquez sur Enregistrer."}
        </p>
        {!status.enabled ? (
          <p className="text-sm text-[var(--warning)]">
            Fonction désactivée : ajoutez{" "}
            <code className="rounded bg-[var(--surface-raised)] px-1">REVOLUT_PAYOUT_ENABLED=true</code>{" "}
            dans le fichier <code className="rounded bg-[var(--surface-raised)] px-1">.env</code>,
            puis redémarrez l&apos;API. Le bouton « Virer mon salaire » apparaîtra sur l&apos;accueil.
          </p>
        ) : null}
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <Field label="Libellé">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          <Field label="Titulaire du compte">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom et prénom"
              required
            />
          </Field>
          <Field label="IBAN">
            <Input
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              placeholder="FR76 ..."
              required
            />
          </Field>
          <div className="flex items-end justify-end sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy
                ? "Enregistrement…"
                : status.hasBeneficiary
                  ? "Remplacer le compte"
                  : "Enregistrer le compte"}
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}
