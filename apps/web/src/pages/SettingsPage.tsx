import { useEffect, useState, type FormEvent } from "react";
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
  urssafRateBps: number;
  reminderQuoteDays: number;
  reminderInvoiceDays: number;
  publicTrackingShowAmounts: boolean;
  businessStartDate: string | null;
  cfeAmountCents: number;
  b2cActivity: boolean;
  incomeTaxReminderMonth: number;
  incomeTaxReminderDay: number;
  inpiUrl: string | null;
  invoiceNumberTemplate: string;
  quoteNumberTemplate: string;
  creditNoteNumberTemplate: string;
  numberCounterWidth: number;
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

  async function load() {
    const [s, c, cl, prev] = await Promise.all([
      api<Settings>("/api/settings"),
      api<Checklist>("/api/checklist"),
      api<LegalClause[]>("/api/legal-clauses"),
      api<{ previews: NumberingPreview[] }>("/api/numbering/preview"),
    ]);
    setSettings(s);
    setChecklist(c);
    setClauses(cl);
    setPreviews(prev.previews);
    setInpiQuery(s.inpiUrl || s.siren || "");
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      const updated = await api<Settings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          legalName: settings.legalName,
          tradeName: settings.tradeName,
          siren: settings.siren,
          siret: settings.siret,
          apeCode: settings.apeCode,
          addressLine1: settings.addressLine1,
          addressLine2: settings.addressLine2,
          postalCode: settings.postalCode,
          city: settings.city,
          country: settings.country,
          email: settings.email,
          phone: settings.phone,
          website: settings.website,
          urssafPeriodicity: settings.urssafPeriodicity,
          treasuryRateBps: settings.treasuryRateBps,
          placementRateBps: settings.placementRateBps,
          reminderQuoteDays: settings.reminderQuoteDays,
          reminderInvoiceDays: settings.reminderInvoiceDays,
          publicTrackingShowAmounts: settings.publicTrackingShowAmounts,
          businessStartDate: settings.businessStartDate
            ? settings.businessStartDate.slice(0, 10)
            : null,
          cfeAmountCents: settings.cfeAmountCents,
          b2cActivity: settings.b2cActivity,
          incomeTaxReminderMonth: settings.incomeTaxReminderMonth,
          incomeTaxReminderDay: settings.incomeTaxReminderDay,
          inpiUrl: settings.inpiUrl,
          invoiceNumberTemplate: settings.invoiceNumberTemplate,
          quoteNumberTemplate: settings.quoteNumberTemplate,
          creditNoteNumberTemplate: settings.creditNoteNumberTemplate,
          numberCounterWidth: settings.numberCounterWidth,
        }),
      });
      setSettings(updated);
      const prev = await api<{ previews: NumberingPreview[] }>("/api/numbering/preview");
      setPreviews(prev.previews);
      toast.success("Paramètres enregistrés");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
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
      setSettings(res.settings);
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

  return (
    <div>
      <PageHeader
        title="Paramètres"
        subtitle="Identité, obligations, conditions légales et trésorerie"
      />

      <form onSubmit={save} className="space-y-8">
        {/* 1. Identité */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">1. Identité entreprise</h2>
          <Card className="space-y-4 border border-gray-200 p-5">
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
                <Input
                  required
                  value={settings.legalName}
                  onChange={(e) => setSettings({ ...settings, legalName: e.target.value })}
                />
              </Field>
              <Field label="Nom commercial">
                <Input
                  value={settings.tradeName ?? ""}
                  onChange={(e) => setSettings({ ...settings, tradeName: e.target.value || null })}
                />
              </Field>
              <Field label="SIREN">
                <Input
                  required
                  value={settings.siren}
                  onChange={(e) => setSettings({ ...settings, siren: e.target.value })}
                />
              </Field>
              <Field label="SIRET">
                <Input
                  required
                  value={settings.siret}
                  onChange={(e) => setSettings({ ...settings, siret: e.target.value })}
                />
              </Field>
              <Field label="APE">
                <Input
                  required
                  value={settings.apeCode}
                  onChange={(e) => setSettings({ ...settings, apeCode: e.target.value })}
                />
              </Field>
              <Field label="Début d'activité">
                <Input
                  type="date"
                  value={settings.businessStartDate?.slice(0, 10) ?? ""}
                  onChange={(e) =>
                    setSettings({ ...settings, businessStartDate: e.target.value || null })
                  }
                />
              </Field>
              <Field label="Adresse" className="sm:col-span-2">
                <Input
                  required
                  value={settings.addressLine1}
                  onChange={(e) => setSettings({ ...settings, addressLine1: e.target.value })}
                />
              </Field>
              <Field label="Code postal">
                <Input
                  required
                  value={settings.postalCode}
                  onChange={(e) => setSettings({ ...settings, postalCode: e.target.value })}
                />
              </Field>
              <Field label="Ville">
                <Input
                  required
                  value={settings.city}
                  onChange={(e) => setSettings({ ...settings, city: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={settings.email ?? ""}
                  onChange={(e) => setSettings({ ...settings, email: e.target.value || null })}
                />
              </Field>
              <Field label="Téléphone">
                <Input
                  value={settings.phone ?? ""}
                  onChange={(e) => setSettings({ ...settings, phone: e.target.value || null })}
                />
              </Field>
            </div>
            <p className="text-xs text-[var(--muted)]">Mention TVA : {settings.vatMention}</p>
          </Card>
        </section>

        {/* 2. Obligations */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold">2. Obligations & déclarations</h2>
          <Card className="space-y-4 border border-gray-200 p-5">
            <p className="text-xs text-[var(--muted)]">
              URSSAF : avant le <strong>15</strong> du mois suivant (ou du mois suivant la fin de
              trimestre). CFE : avant le <strong>15 décembre</strong> de l&apos;année en cours.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Périodicité URSSAF">
                <Select
                  value={settings.urssafPeriodicity}
                  onChange={(e) =>
                    setSettings({ ...settings, urssafPeriodicity: e.target.value })
                  }
                >
                  <option value="MONTHLY">Mensuelle</option>
                  <option value="QUARTERLY">Trimestrielle</option>
                </Select>
              </Field>
              <Field label="Montant CFE (€)">
                <Input
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
                  <Input
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
                  <Input
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
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.b2cActivity}
                onChange={(e) => setSettings({ ...settings, b2cActivity: e.target.checked })}
              />
              Je facture des particuliers (rappel médiation)
            </label>
            {checklist ? (
              <div className="border-t border-gray-200 pt-4">
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
          <h2 className="text-base font-semibold">3. Numérotation des documents</h2>
          <Card className="space-y-4 border border-gray-200 p-5">
            <p className="text-xs text-[var(--muted)]">
              Variables : {"{prefix}"}, {"{year}"}, {"{counter}"}. Attribution uniquement à
              l&apos;émission. Séries distinctes : factures (dont acomptes), devis, avoirs.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Template factures">
                <Input
                  value={settings.invoiceNumberTemplate}
                  onChange={(e) =>
                    setSettings({ ...settings, invoiceNumberTemplate: e.target.value })
                  }
                />
              </Field>
              <Field label="Template devis">
                <Input
                  value={settings.quoteNumberTemplate}
                  onChange={(e) =>
                    setSettings({ ...settings, quoteNumberTemplate: e.target.value })
                  }
                />
              </Field>
              <Field label="Template avoirs">
                <Input
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
                <Input
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
                  className="rounded-md border border-gray-200 bg-[var(--bg)] px-3 py-2"
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
                    ? "border-green-200 bg-green-50 text-green-900"
                    : "border-red-200 bg-red-50 text-red-900"
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
            <h2 className="text-base font-semibold">4. Conditions générales (PDF)</h2>
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
          <Card className="divide-y divide-gray-200 border border-gray-200">
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
          <h2 className="text-base font-semibold">5. Trésorerie & relances</h2>
          <Card className="grid gap-4 border border-gray-200 p-5 sm:grid-cols-2">
            <Field label="Enveloppe frais (bps)">
              <Input
                type="number"
                value={settings.treasuryRateBps}
                onChange={(e) =>
                  setSettings({ ...settings, treasuryRateBps: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Enveloppe placements (bps)">
              <Input
                type="number"
                value={settings.placementRateBps}
                onChange={(e) =>
                  setSettings({ ...settings, placementRateBps: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Relance devis (j)">
              <Input
                type="number"
                value={settings.reminderQuoteDays}
                onChange={(e) =>
                  setSettings({ ...settings, reminderQuoteDays: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Relance facture (j)">
              <Input
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
                  setSettings({
                    ...settings,
                    publicTrackingShowAmounts: e.target.checked,
                  })
                }
              />
              Afficher les montants sur le suivi public client
            </label>
          </Card>
        </section>

        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </form>

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
