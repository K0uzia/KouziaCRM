import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { AddressAutocomplete, type AddressValue } from "@/components/forms/AddressAutocomplete";
import { SettingsTabNav } from "@/pages/settings/TabNav";
import { SecretField } from "@/pages/settings/SecretField";
import {
  SETTINGS_TABS,
  type PublicSettings,
  type SettingsTabId,
} from "@/pages/settings/types";

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
  series: Array<{
    series: string;
    year: number;
    issuedCount: number;
    holes: number[];
    duplicates: Array<{ value: number }>;
    ok: boolean;
  }>;
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

function isTab(v: string | null): v is SettingsTabId {
  return SETTINGS_TABS.some((t) => t.id === v);
}

function pct(bps: number): string {
  return (bps / 100).toFixed(0);
}

function fromPct(value: string): number {
  return Math.round(Number(value) * 100);
}

function withTwoDepositMilestones(s: PublicSettings): PublicSettings {
  const acompte = Math.min(9900, Math.max(100, s.depositPercent1Bps || 3000));
  return {
    ...s,
    depositCount: 2,
    depositPercent1Bps: acompte,
    depositPercent2Bps: 10000 - acompte,
    depositPercent3Bps: 0,
  };
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab: SettingsTabId = isTab(params.get("tab")) ? params.get("tab")! : "general";
  const setTab = (id: SettingsTabId) => {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    setParams(next, { replace: true });
  };

  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<PublicSettings | null>(null);
  const [smtpPass, setSmtpPass] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [requireSmtpPass, setRequireSmtpPass] = useState(false);
  const [revolutKey, setRevolutKey] = useState("");
  const [revolutWebhook, setRevolutWebhook] = useState("");
  const [testEmailTo, setTestEmailTo] = useState("");
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [clauses, setClauses] = useState<LegalClause[]>([]);
  const [previews, setPreviews] = useState<NumberingPreview[]>([]);
  const [audit, setAudit] = useState<NumberingAudit | null>(null);
  const [busy, setBusy] = useState(false);
  const [inpiQuery, setInpiQuery] = useState("");
  const [clauseModal, setClauseModal] = useState<LegalClause | "new" | null>(null);
  const [clauseForm, setClauseForm] = useState({ title: "", body: "", kind: "CUSTOM" });
  const [imapTest, setImapTest] = useState<string | null>(null);

  const d = form?.emailDefaults;

  async function load() {
    const [s, c, cl, prev] = await Promise.all([
      api<PublicSettings>("/api/settings"),
      api<Checklist>("/api/checklist"),
      api<LegalClause[]>("/api/legal-clauses"),
      api<{ previews: NumberingPreview[] }>("/api/numbering/preview"),
    ]);
    setSettings(s);
    setForm(withTwoDepositMilestones(s));
    setChecklist(c);
    setClauses(cl);
    setPreviews(prev.previews);
    setInpiQuery(s.inpiUrl || s.siren || "");
    setTestEmailTo(s.email || "");
    setSmtpPass("");
    setImapPass("");
    setRevolutKey("");
    setRevolutWebhook("");
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  const addressValue: AddressValue | null = useMemo(() => {
    if (!form) return null;
    return {
      addressLine1: form.addressLine1,
      addressLine2: form.addressLine2 ?? "",
      postalCode: form.postalCode,
      city: form.city,
      country: form.country,
      addressCityCode: "",
      addressLat: null,
      addressLon: null,
      addressManualConfirmed: true,
    };
  }, [form]);

  async function save(path: string, body: unknown) {
    setBusy(true);
    try {
      const updated = await api<PublicSettings>(path, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSettings(updated);
      setForm(updated);
      setSmtpPass("");
      setImapPass("");
      setRevolutKey("");
      setRevolutWebhook("");
      toast.success("Enregistré");
      if (path.includes("numbering") || body && typeof body === "object" && "invoiceNumberTemplate" in (body as object)) {
        const prev = await api<{ previews: NumberingPreview[] }>("/api/numbering/preview");
        setPreviews(prev.previews);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function saveGeneral() {
    if (!form) return;
    await save("/api/settings/general", {
      legalName: form.legalName,
      tradeName: form.tradeName,
      siren: form.siren,
      siret: form.siret,
      apeCode: form.apeCode,
      addressLine1: form.addressLine1,
      addressLine2: form.addressLine2,
      postalCode: form.postalCode,
      city: form.city,
      country: form.country,
      email: form.email,
      phone: form.phone,
      website: form.website,
      legalForm: form.legalForm,
      rcsMention: form.rcsMention,
      vatIntraNumber: form.vatIntraNumber,
      decennaleInsurer: form.decennaleInsurer,
      decennalePolicyNumber: form.decennalePolicyNumber,
      decennaleCoverageZone: form.decennaleCoverageZone,
      publicTrackingShowAmounts: form.publicTrackingShowAmounts,
      clientPortalUrl: form.clientPortalUrl,
      inpiUrl: form.inpiUrl,
    });
  }

  async function saveEmail() {
    if (!form) return;
    const isHostinger =
      (form.smtpHost ?? "").includes("hostinger.com") ||
      form.emailPresets?.hostinger.smtpHost === form.smtpHost;
    if (requireSmtpPass && isHostinger) {
      if (!smtpPass) {
        toast.error(
          "Saisissez le mot de passe de la boîte contact@kouzia.com (hPanel > Emails), puis Enregistrer.",
        );
        return;
      }
      if (form.imapHost && !imapPass) {
        toast.error(
          "Saisissez aussi le mot de passe IMAP (même mot de passe que SMTP pour Hostinger), puis Enregistrer.",
        );
        return;
      }
    }
    const encryption = form.smtpEncryptionResolved || "SSL";
    await save("/api/settings/email", {
      smtpHost: form.smtpHost || null,
      smtpPort: form.smtpPort,
      smtpEncryption: encryption,
      smtpUser: form.smtpUser || null,
      smtpPass: smtpPass || undefined,
      smtpFrom: form.smtpFrom || null,
      smtpFromName: form.smtpFromName || null,
      smtpReplyTo: form.smtpReplyTo || null,
      emailThrottlePerMinute: form.emailThrottlePerMinute,
      imapHost: form.imapHost || null,
      imapPort: form.imapPort,
      imapSecure: form.imapSecure,
      imapUser: form.imapUser || null,
      imapPass: imapPass || undefined,
      imapMailbox: form.imapMailbox || "INBOX",
      imapPollIntervalMinutes: form.imapPollIntervalMinutes,
      attachmentMaxFileMb: form.attachmentMaxFileMb,
      attachmentMaxMessageMb: form.attachmentMaxMessageMb,
    });
    setRequireSmtpPass(false);
  }

  function applyMailPreset(kind: "hostinger" | "mailpit") {
    if (!form) return;
    const preset = form.emailPresets?.[kind] ?? (kind === "hostinger" ? form.emailDefaults : null);
    if (!preset) return;
    setForm({
      ...form,
      smtpHost: preset.smtpHost || null,
      smtpPort: preset.smtpPort,
      smtpEncryptionResolved: preset.smtpEncryption,
      smtpUser: preset.smtpUser || null,
      smtpFromName: preset.smtpFromName || null,
      smtpFrom: preset.smtpFrom || null,
      smtpReplyTo: preset.smtpReplyTo || null,
      imapHost: preset.imapHost || null,
      imapPort: preset.imapPort,
      imapSecure: preset.imapSecure,
      imapUser: preset.imapUser || null,
      imapMailbox: preset.imapMailbox || "INBOX",
    });
    if (kind === "mailpit") {
      setSmtpPass("");
      setImapPass("");
      setRequireSmtpPass(false);
      toast.message(
        "Preset Mailpit (dev) appliqué : port 1025, sans authentification. Cliquez Enregistrer puis Testez.",
      );
    } else {
      setSmtpPass("");
      setImapPass("");
      setRequireSmtpPass(true);
      toast.message(
        "Preset Hostinger appliqué. Collez le mot de passe de la boîte mail (pas hPanel), Enregistrer, puis Testez.",
      );
    }
  }

  async function savePayments() {
    if (!form) return;
    await save("/api/settings/payments", {
      bankIban: form.bankIban,
      bankBic: form.bankBic,
      bankAccountHolder: form.bankAccountHolder,
      bankName: form.bankName,
      revolutMerchantApiKey: revolutKey || undefined,
      revolutWebhookSecret: revolutWebhook || undefined,
      revolutMerchantMode: form.revolutMerchantMode,
      depositCount: 2,
      depositPercent1Bps: form.depositPercent1Bps,
      depositPercent2Bps: form.depositPercent2Bps,
      depositPercent3Bps: 0,
      paymentButtonLeadDays: form.paymentButtonLeadDays,
    });
  }

  async function saveReminders() {
    if (!form) return;
    await save("/api/settings/reminders", {
      reminderQuoteDays: form.reminderQuoteDays,
      reminderInvoiceDays: form.reminderInvoiceDays,
      reminderDepositMinus7Days: form.reminderDepositMinus7Days,
      reminderDepositMinus1Days: form.reminderDepositMinus1Days,
      reminderDepositPlus3Days: form.reminderDepositPlus3Days,
      reminderDepositPlus10Days: form.reminderDepositPlus10Days,
      reminderDepositMinus7Enabled: form.reminderDepositMinus7Enabled,
      reminderDepositMinus1Enabled: form.reminderDepositMinus1Enabled,
      reminderDepositPlus3Enabled: form.reminderDepositPlus3Enabled,
      reminderDepositPlus10Enabled: form.reminderDepositPlus10Enabled,
    });
  }

  async function saveIdentity() {
    if (!form) return;
    await save("/api/settings/identity", {
      brandPrimaryColor: form.brandPrimaryColor,
      brandSecondaryColor: form.brandSecondaryColor,
      pdfFooterText: form.pdfFooterText,
      vatMention: form.vatMention,
      latePenaltiesText: form.latePenaltiesText,
      earlyPaymentDiscountText: form.earlyPaymentDiscountText,
      paymentConditions: form.paymentConditions,
    });
  }

  async function saveDeclarations() {
    if (!form) return;
    await save("/api/settings/declarations", {
      urssafPeriodicity: form.urssafPeriodicity,
      treasuryRateBps: form.treasuryRateBps,
      placementRateBps: form.placementRateBps,
      lastIncomeTaxDeclaredYear: form.lastIncomeTaxDeclaredYear,
      cfeAmountCents: form.cfeAmountCents,
      b2cActivity: form.b2cActivity,
      incomeTaxReminderMonth: form.incomeTaxReminderMonth,
      incomeTaxReminderDay: form.incomeTaxReminderDay,
      businessStartDate: form.businessStartDate?.slice(0, 10) ?? null,
      rneRegistrationDate: form.rneRegistrationDate?.slice(0, 10) ?? null,
    });
  }

  async function saveNumbering() {
    if (!form) return;
    setBusy(true);
    try {
      const res = await api<{ settings: PublicSettings; previews: NumberingPreview[] }>(
        "/api/settings/numbering",
        {
          method: "PATCH",
          body: JSON.stringify({
            invoiceNumberTemplate: form.invoiceNumberTemplate,
            quoteNumberTemplate: form.quoteNumberTemplate,
            creditNoteNumberTemplate: form.creditNoteNumberTemplate,
            numberCounterWidth: form.numberCounterWidth,
          }),
        },
      );
      setSettings(res.settings);
      setForm(res.settings);
      setPreviews(res.previews);
      toast.success("Enregistré");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function importInpi() {
    setBusy(true);
    try {
      const res = await api<{ settings: PublicSettings; import: { warnings: string[] } }>(
        "/api/settings/import-inpi",
        { method: "POST", body: JSON.stringify({ query: inpiQuery }) },
      );
      setSettings(res.settings);
      setForm(res.settings);
      for (const w of res.import.warnings) toast.message(w);
      toast.success("Identité mise à jour depuis l'open data / INPI");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import impossible");
    } finally {
      setBusy(false);
    }
  }

  async function testSmtp() {
    setBusy(true);
    try {
      const res = await api<{
        ok: boolean;
        to: string;
        source?: string;
        host?: string;
        port?: number;
      }>("/api/settings/email/test-smtp", {
        method: "POST",
        body: JSON.stringify({
          to: testEmailTo || undefined,
          smtpHost: form?.smtpHost,
          smtpPort: form?.smtpPort,
          smtpEncryption: form?.smtpEncryptionResolved,
          smtpUser: form?.smtpUser,
          smtpFrom: form?.smtpFrom,
          smtpPass: smtpPass || undefined,
        }),
      });
      const via =
        res.source === "draft"
          ? " (valeurs du formulaire)"
          : res.source === "db"
            ? " (paramètres enregistrés)"
            : "";
      toast.success(`Email de test envoyé à ${res.to}${via}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec du test", { duration: 8000 });
    } finally {
      setBusy(false);
    }
  }

  async function testImap() {
    setBusy(true);
    setImapTest(null);
    try {
      const res = await api<{ ok: true; mailbox: string; source?: string }>(
        "/api/settings/email/test-imap",
        {
          method: "POST",
          body: JSON.stringify({
            imapHost: form?.imapHost,
            imapPort: form?.imapPort,
            imapSecure: form?.imapSecure,
            imapUser: form?.imapUser,
            imapPass: imapPass || undefined,
            imapMailbox: form?.imapMailbox,
          }),
        },
      );
      const via =
        res.source === "draft"
          ? " (valeurs du formulaire)"
          : res.source === "db"
            ? " (paramètres enregistrés)"
            : "";
      setImapTest(`Connexion OK (boîte ${res.mailbox})${via}`);
      toast.success(`IMAP OK${via}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Échec IMAP";
      setImapTest(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function testRevolut() {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; mode: string }>("/api/settings/payments/test-revolut", {
        method: "POST",
        body: "{}",
      });
      toast.success(`API Merchant OK (${res.mode})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec Revolut");
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const updated = await api<PublicSettings>("/api/settings/identity/logo", {
        method: "POST",
        body: fd,
      });
      setSettings(updated);
      setForm(updated);
      toast.success("Logo mis à jour");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload impossible");
    } finally {
      setBusy(false);
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
        await api("/api/legal-clauses", { method: "POST", body: JSON.stringify(clauseForm) });
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

  async function copyWebhook() {
    if (!form) return;
    try {
      await navigator.clipboard.writeText(form.revolutWebhookUrl);
      toast.success("URL copiée");
    } catch {
      toast.error("Copie impossible");
    }
  }

  if (!form || !settings) {
    return <p className="text-sm text-[var(--muted)]">Chargement…</p>;
  }

  const SaveBar = ({ onSave }: { onSave: () => void }) => (
    <div className="flex justify-end border-t border-[var(--border)] pt-4">
      <Button type="button" disabled={busy} onClick={() => void onSave()}>
        {busy ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Paramètres"
        subtitle="Configuration par onglet : identité, emails Hostinger, paiements, charte"
        actions={busy ? <span className="text-xs text-[var(--muted)]">Enregistrement…</span> : null}
      />

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <SettingsTabNav active={tab} onChange={setTab} />

        <div className="min-w-0 flex-1 space-y-4">
          {tab === "general" ? (
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
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nom légal">
                  <Input
                    value={form.legalName}
                    onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                  />
                </Field>
                <Field label="Nom commercial">
                  <Input
                    value={form.tradeName ?? ""}
                    onChange={(e) => setForm({ ...form, tradeName: e.target.value || null })}
                  />
                </Field>
                <Field label="Forme juridique">
                  <Input
                    placeholder="EI"
                    value={form.legalForm ?? ""}
                    onChange={(e) => setForm({ ...form, legalForm: e.target.value || null })}
                  />
                </Field>
                <Field label="RCS / RNE">
                  <Input
                    placeholder="RNE / non inscrit RCS"
                    value={form.rcsMention ?? ""}
                    onChange={(e) => setForm({ ...form, rcsMention: e.target.value || null })}
                  />
                </Field>
                <Field label="SIREN">
                  <Input value={form.siren} onChange={(e) => setForm({ ...form, siren: e.target.value })} />
                </Field>
                <Field label="SIRET">
                  <Input value={form.siret} onChange={(e) => setForm({ ...form, siret: e.target.value })} />
                </Field>
                <Field label="APE">
                  <Input value={form.apeCode} onChange={(e) => setForm({ ...form, apeCode: e.target.value })} />
                </Field>
                <Field label="N° TVA intracom">
                  <Input
                    placeholder="Franchise de base : laisser vide"
                    value={form.vatIntraNumber ?? ""}
                    onChange={(e) => setForm({ ...form, vatIntraNumber: e.target.value || null })}
                  />
                </Field>
                <Field label="Email de contact">
                  <Input
                    type="email"
                    value={form.email ?? ""}
                    onChange={(e) => setForm({ ...form, email: e.target.value || null })}
                  />
                </Field>
                <Field label="Téléphone">
                  <Input
                    value={form.phone ?? ""}
                    onChange={(e) => setForm({ ...form, phone: e.target.value || null })}
                  />
                </Field>
                <Field label="Site web">
                  <Input
                    value={form.website ?? ""}
                    onChange={(e) => setForm({ ...form, website: e.target.value || null })}
                  />
                </Field>
                <Field label="URL du portail client">
                  <Input
                    className="sm:col-span-2"
                    placeholder="https://kouzia.com/suivi"
                    value={form.clientPortalUrl ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, clientPortalUrl: e.target.value || null })
                    }
                  />
                </Field>
              </div>
              {addressValue ? (
                <AddressAutocomplete
                  value={addressValue}
                  onChange={(next) =>
                    setForm({
                      ...form,
                      addressLine1: next.addressLine1,
                      addressLine2: next.addressLine2 || null,
                      postalCode: next.postalCode,
                      city: next.city,
                      country: next.country,
                    })
                  }
                />
              ) : null}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Assurance décennale : assureur">
                  <Input
                    value={form.decennaleInsurer ?? ""}
                    onChange={(e) => setForm({ ...form, decennaleInsurer: e.target.value || null })}
                  />
                </Field>
                <Field label="N° de police">
                  <Input
                    value={form.decennalePolicyNumber ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, decennalePolicyNumber: e.target.value || null })
                    }
                  />
                </Field>
                <Field label="Zone de couverture">
                  <Input
                    value={form.decennaleCoverageZone ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, decennaleCoverageZone: e.target.value || null })
                    }
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.publicTrackingShowAmounts}
                  onChange={(e) =>
                    setForm({ ...form, publicTrackingShowAmounts: e.target.checked })
                  }
                />
                Afficher les montants sur le suivi public client
              </label>
              <SaveBar onSave={saveGeneral} />
            </Card>
          ) : null}

          {tab === "email" ? (
            <Card className="space-y-6 border border-[var(--border)] p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
                <p className="text-xs text-[var(--muted)]">
                  Presets : remplissent le formulaire. Pensez à <strong>Enregistrer</strong> ensuite.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 text-xs"
                    onClick={() => applyMailPreset("hostinger")}
                  >
                    Config Hostinger
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 text-xs"
                    onClick={() => applyMailPreset("mailpit")}
                  >
                    Config Mailpit (dev)
                  </Button>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Envoi (SMTP)</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Hostinger : smtp.hostinger.com:465 SSL · Dev : Mailpit 127.0.0.1:1025 (UI :8025).
                  Le test utilise le formulaire (mot de passe saisi) même avant Enregistrer.
                </p>
                {requireSmtpPass ? (
                  <p className="mt-2 rounded-[var(--radius-sm)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]">
                    Mot de passe Hostinger requis (SMTP et IMAP) : celui de la boîte mail dans hPanel
                    &gt; Emails, pas votre mot de passe hPanel.
                  </p>
                ) : null}
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Hôte">
                    <Input
                      placeholder={d?.smtpHost}
                      value={form.smtpHost ?? ""}
                      onChange={(e) => setForm({ ...form, smtpHost: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      type="number"
                      value={form.smtpPort ?? d?.smtpPort ?? 465}
                      onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Chiffrement">
                    <Select
                      value={form.smtpEncryptionResolved || "SSL"}
                      onChange={(e) =>
                        setForm({ ...form, smtpEncryptionResolved: e.target.value })
                      }
                    >
                      <option value="SSL">SSL / TLS (465)</option>
                      <option value="STARTTLS">STARTTLS (587)</option>
                      <option value="NONE">Aucun</option>
                    </Select>
                  </Field>
                  <Field label="Utilisateur">
                    <Input
                      placeholder={d?.smtpUser}
                      value={form.smtpUser ?? ""}
                      onChange={(e) => setForm({ ...form, smtpUser: e.target.value || null })}
                    />
                  </Field>
                  <SecretField
                    label="Mot de passe SMTP"
                    value={smtpPass}
                    onChange={setSmtpPass}
                    secret={form.secrets.smtpPass}
                  />
                  <Field label="Nom d'expéditeur">
                    <Input
                      placeholder={d?.smtpFromName}
                      value={form.smtpFromName ?? ""}
                      onChange={(e) => setForm({ ...form, smtpFromName: e.target.value || null })}
                    />
                  </Field>
                  <Field label="From (complet)" className="sm:col-span-2">
                    <Input
                      placeholder={d?.smtpFrom}
                      value={form.smtpFrom ?? ""}
                      onChange={(e) => setForm({ ...form, smtpFrom: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Reply-To">
                    <Input
                      placeholder={d?.smtpReplyTo}
                      value={form.smtpReplyTo ?? ""}
                      onChange={(e) => setForm({ ...form, smtpReplyTo: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Throttle (emails / min)">
                    <Input
                      type="number"
                      min={1}
                      max={120}
                      value={form.emailThrottlePerMinute}
                      onChange={(e) =>
                        setForm({ ...form, emailThrottlePerMinute: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <Field label="Adresse de test" className="min-w-[220px] flex-1">
                    <Input
                      type="email"
                      value={testEmailTo}
                      onChange={(e) => setTestEmailTo(e.target.value)}
                    />
                  </Field>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => void testSmtp()}>
                    Tester l&apos;envoi
                  </Button>
                </div>
              </div>

              <div className="border-t border-[var(--border)] pt-4">
                <h3 className="text-sm font-semibold">Réception (IMAP)</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Hostinger : imap.hostinger.com:993 SSL. Mailpit (dev) n&apos;a pas d&apos;IMAP :
                  laissez vide. Le test utilise le formulaire (mot de passe saisi) même avant
                  Enregistrer. Polling toutes les {form.imapPollIntervalMinutes} min + bouton
                  Synchroniser dans Messages.
                </p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Hôte IMAP">
                    <Input
                      placeholder={d?.imapHost}
                      value={form.imapHost ?? ""}
                      onChange={(e) => setForm({ ...form, imapHost: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      type="number"
                      value={form.imapPort ?? d?.imapPort ?? 993}
                      onChange={(e) => setForm({ ...form, imapPort: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Utilisateur">
                    <Input
                      placeholder={d?.imapUser}
                      value={form.imapUser ?? ""}
                      onChange={(e) => setForm({ ...form, imapUser: e.target.value || null })}
                    />
                  </Field>
                  <SecretField
                    label="Mot de passe IMAP"
                    value={imapPass}
                    onChange={setImapPass}
                    secret={form.secrets.imapPass}
                  />
                  <Field label="Boîte">
                    <Input
                      value={form.imapMailbox}
                      onChange={(e) => setForm({ ...form, imapMailbox: e.target.value })}
                    />
                  </Field>
                  <Field label="Intervalle de polling (min)">
                    <Input
                      type="number"
                      min={5}
                      max={120}
                      value={form.imapPollIntervalMinutes}
                      onChange={(e) =>
                        setForm({ ...form, imapPollIntervalMinutes: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={form.imapSecure}
                      onChange={(e) => setForm({ ...form, imapSecure: e.target.checked })}
                    />
                    Connexion SSL / TLS
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => void testImap()}>
                    Tester la connexion IMAP
                  </Button>
                  {imapTest ? (
                    <span className="text-xs text-[var(--muted)]">{imapTest}</span>
                  ) : null}
                </div>
              </div>

              <div className="border-t border-[var(--border)] pt-4">
                <h3 className="text-sm font-semibold">Pièces jointes (stockage ERP)</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Défauts calés sur un mail riche : 2-3 PDF, photos, parfois une video courte
                  compressée. Hostinger limite souvent l&apos;envoi à ~50 Mo : ces plafonds
                  concernent ce que l&apos;ERP conserve après réception.
                </p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="Max par fichier (Mo)">
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={form.attachmentMaxFileMb}
                      onChange={(e) =>
                        setForm({ ...form, attachmentMaxFileMb: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Max par message (Mo)">
                    <Input
                      type="number"
                      min={1}
                      max={500}
                      value={form.attachmentMaxMessageMb}
                      onChange={(e) =>
                        setForm({ ...form, attachmentMaxMessageMb: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
              </div>
              <SaveBar onSave={saveEmail} />
            </Card>
          ) : null}

          {tab === "payments" ? (
            <div className="space-y-4">
              <Card className="space-y-4 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Coordonnées bancaires (virement)</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Titulaire">
                    <Input
                      value={form.bankAccountHolder ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, bankAccountHolder: e.target.value || null })
                      }
                    />
                  </Field>
                  <Field label="Banque">
                    <Input
                      value={form.bankName ?? ""}
                      onChange={(e) => setForm({ ...form, bankName: e.target.value || null })}
                    />
                  </Field>
                  <Field label="IBAN">
                    <Input
                      value={form.bankIban ?? ""}
                      onChange={(e) => setForm({ ...form, bankIban: e.target.value || null })}
                    />
                  </Field>
                  <Field label="BIC">
                    <Input
                      value={form.bankBic ?? ""}
                      onChange={(e) => setForm({ ...form, bankBic: e.target.value || null })}
                    />
                  </Field>
                </div>
              </Card>

              <Card className="space-y-4 border border-[var(--border)] p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">Revolut Merchant (encaissement en ligne)</h3>
                  {form.revolutMerchantMode === "production" ? (
                    <span className="rounded-full bg-[var(--warning-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--warning)]">
                      Mode production
                    </span>
                  ) : (
                    <span className="rounded-full bg-[var(--info-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--info)]">
                      Sandbox
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--muted)]">
                  Distinct de l&apos;API Business (rapprochement bancaire / virements). Clés générées
                  dans le portail Merchant Revolut.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SecretField
                    label="Clé API secrète"
                    value={revolutKey}
                    onChange={setRevolutKey}
                    secret={form.secrets.revolutMerchantApiKey}
                  />
                  <SecretField
                    label="Secret webhook"
                    value={revolutWebhook}
                    onChange={setRevolutWebhook}
                    secret={form.secrets.revolutWebhookSecret}
                  />
                  <Field label="Mode">
                    <Select
                      value={form.revolutMerchantMode}
                      onChange={(e) => setForm({ ...form, revolutMerchantMode: e.target.value })}
                    >
                      <option value="sandbox">Sandbox</option>
                      <option value="production">Production</option>
                    </Select>
                  </Field>
                </div>
                <Field label="URL webhook (à coller dans le portail Merchant)">
                  <div className="flex gap-2">
                    <Input readOnly value={form.revolutWebhookUrl} />
                    <Button type="button" variant="secondary" onClick={() => void copyWebhook()}>
                      Copier
                    </Button>
                  </div>
                </Field>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void testRevolut()}>
                  Tester la connexion API
                </Button>
              </Card>

              <Card className="space-y-4 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Échéancier d&apos;acomptes</h3>
                <p className="text-xs text-[var(--muted)]">
                  Deux échéances seulement : un acompte à la validation du devis, puis le
                  solde à la livraison. Les devis déjà émis avec un jalon intermédiaire
                  conservent leur calendrier.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Acompte à la validation (%)">
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={pct(form.depositPercent1Bps)}
                      onChange={(e) => {
                        const acompte = fromPct(e.target.value);
                        setForm({
                          ...form,
                          depositPercent1Bps: acompte,
                          depositPercent2Bps: Math.max(0, 10000 - acompte),
                          depositPercent3Bps: 0,
                          depositCount: 2,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Solde à la livraison (%)">
                    <Input
                      type="number"
                      readOnly
                      value={pct(form.depositPercent2Bps)}
                    />
                  </Field>
                  <Field label="Bouton paiement J-x (jours avant échéance)">
                    <Input
                      type="number"
                      min={0}
                      max={30}
                      value={form.paymentButtonLeadDays}
                      onChange={(e) =>
                        setForm({ ...form, paymentButtonLeadDays: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
                <SaveBar onSave={savePayments} />
              </Card>

              <PayoutBeneficiaryCard />
            </div>
          ) : null}

          {tab === "reminders" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <h3 className="text-sm font-semibold">Relances devis / factures</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Relance devis (j après émission)">
                  <Input
                    type="number"
                    value={form.reminderQuoteDays}
                    onChange={(e) =>
                      setForm({ ...form, reminderQuoteDays: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="Relance facture (j après échéance)">
                  <Input
                    type="number"
                    value={form.reminderInvoiceDays}
                    onChange={(e) =>
                      setForm({ ...form, reminderInvoiceDays: Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
              <h3 className="pt-2 text-sm font-semibold">Rappels d&apos;acomptes</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["reminderDepositMinus7", "J-7 avant échéance", "minus7"],
                    ["reminderDepositMinus1", "J-1 avant échéance", "minus1"],
                    ["reminderDepositPlus3", "J+3 après échéance", "plus3"],
                    ["reminderDepositPlus10", "J+10 après échéance", "plus10"],
                  ] as const
                ).map(([prefix, label]) => {
                  const daysKey = `${prefix}Days` as keyof PublicSettings;
                  const enKey = `${prefix}Enabled` as keyof PublicSettings;
                  return (
                    <div
                      key={prefix}
                      className="flex items-end gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] p-3"
                    >
                      <label className="flex items-center gap-2 pb-2 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(form[enKey])}
                          onChange={(e) =>
                            setForm({ ...form, [enKey]: e.target.checked } as PublicSettings)
                          }
                        />
                      </label>
                      <Field label={label} className="flex-1">
                        <Input
                          type="number"
                          value={Number(form[daysKey])}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              [daysKey]: Number(e.target.value),
                            } as PublicSettings)
                          }
                        />
                      </Field>
                    </div>
                  );
                })}
              </div>
              <SaveBar onSave={saveReminders} />
            </Card>
          ) : null}

          {tab === "identity" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Couleur primaire">
                  <div className="flex gap-2">
                    <input
                      type="color"
                      className="h-10 w-14 cursor-pointer rounded border border-[var(--border)] bg-transparent"
                      value={form.brandPrimaryColor}
                      onChange={(e) => setForm({ ...form, brandPrimaryColor: e.target.value })}
                    />
                    <Input
                      value={form.brandPrimaryColor}
                      onChange={(e) => setForm({ ...form, brandPrimaryColor: e.target.value })}
                    />
                  </div>
                </Field>
                <Field label="Couleur secondaire">
                  <div className="flex gap-2">
                    <input
                      type="color"
                      className="h-10 w-14 cursor-pointer rounded border border-[var(--border)] bg-transparent"
                      value={form.brandSecondaryColor}
                      onChange={(e) => setForm({ ...form, brandSecondaryColor: e.target.value })}
                    />
                    <Input
                      value={form.brandSecondaryColor}
                      onChange={(e) => setForm({ ...form, brandSecondaryColor: e.target.value })}
                    />
                  </div>
                </Field>
              </div>
              <Field label="Logo">
                <div className="flex flex-wrap items-center gap-4">
                  {form.brandLogoPath ? (
                    <img
                      src="/api/settings/identity/logo"
                      alt="Logo"
                      className="h-16 max-w-[160px] object-contain"
                    />
                  ) : (
                    <span className="text-xs text-[var(--muted)]">Aucun logo</span>
                  )}
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadLogo(f);
                    }}
                  />
                </div>
              </Field>
              <Field label="Mention TVA">
                <Textarea
                  rows={2}
                  value={form.vatMention}
                  onChange={(e) => setForm({ ...form, vatMention: e.target.value })}
                />
              </Field>
              <Field label="Conditions de paiement">
                <Textarea
                  rows={2}
                  value={form.paymentConditions}
                  onChange={(e) => setForm({ ...form, paymentConditions: e.target.value })}
                />
              </Field>
              <Field label="Pénalités de retard">
                <Textarea
                  rows={3}
                  value={form.latePenaltiesText}
                  onChange={(e) => setForm({ ...form, latePenaltiesText: e.target.value })}
                />
              </Field>
              <Field label="Escompte paiement anticipé">
                <Textarea
                  rows={2}
                  value={form.earlyPaymentDiscountText}
                  onChange={(e) => setForm({ ...form, earlyPaymentDiscountText: e.target.value })}
                />
              </Field>
              <Field label="Pied de page PDF">
                <Textarea
                  rows={2}
                  value={form.pdfFooterText ?? ""}
                  onChange={(e) => setForm({ ...form, pdfFooterText: e.target.value || null })}
                />
              </Field>
              <SaveBar onSave={saveIdentity} />
            </Card>
          ) : null}

          {tab === "numbering" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <p className="text-xs text-[var(--muted)]">
                Variables : {"{prefix}"}, {"{year}"}, {"{counter}"}. Attribution uniquement à
                l&apos;émission.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Template factures">
                  <Input
                    value={form.invoiceNumberTemplate}
                    onChange={(e) => setForm({ ...form, invoiceNumberTemplate: e.target.value })}
                  />
                </Field>
                <Field label="Template devis">
                  <Input
                    value={form.quoteNumberTemplate}
                    onChange={(e) => setForm({ ...form, quoteNumberTemplate: e.target.value })}
                  />
                </Field>
                <Field label="Template avoirs">
                  <Input
                    value={form.creditNoteNumberTemplate}
                    onChange={(e) =>
                      setForm({ ...form, creditNoteNumberTemplate: e.target.value })
                    }
                  />
                </Field>
                <Field label="Largeur compteur">
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={form.numberCounterWidth}
                    onChange={(e) =>
                      setForm({ ...form, numberCounterWidth: Number(e.target.value) })
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
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void api<NumberingAudit>("/api/numbering/audit")
                      .then((a) => {
                        setAudit(a);
                        toast.success("Audit terminé");
                      })
                      .catch((e: Error) => toast.error(e.message))
                  }
                >
                  Audit d&apos;intégrité
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void api("/api/settings/numbering/reseed", { method: "POST", body: "{}" })
                      .then(async () => {
                        setPreviews(
                          (await api<{ previews: NumberingPreview[] }>("/api/numbering/preview"))
                            .previews,
                        );
                        toast.success("Compteurs recalculés");
                      })
                      .catch((e: Error) => toast.error(e.message))
                  }
                >
                  Reseed compteurs
                </Button>
              </div>
              {audit ? (
                <p className="text-xs text-[var(--muted)]">
                  {audit.ok ? "Séries continues : OK" : "Anomalies détectées"} ·{" "}
                  {audit.series
                    .map((s) => `${s.series} ${s.year}: ${s.issuedCount} doc(s)`)
                    .join(" · ")}
                </p>
              ) : null}
              <SaveBar onSave={saveNumbering} />
            </Card>
          ) : null}

          {tab === "declarations" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Périodicité URSSAF">
                  <Select
                    value={form.urssafPeriodicity}
                    onChange={(e) => setForm({ ...form, urssafPeriodicity: e.target.value })}
                  >
                    <option value="MONTHLY">Mensuelle</option>
                    <option value="QUARTERLY">Trimestrielle</option>
                  </Select>
                </Field>
                <Field label="Montant CFE (€)">
                  <Input
                    type="number"
                    step="0.01"
                    value={(form.cfeAmountCents / 100).toFixed(2)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        cfeAmountCents: Math.round(Number(e.target.value) * 100),
                      })
                    }
                  />
                </Field>
                <Field label="Début d'activité">
                  <Input
                    type="date"
                    value={form.businessStartDate?.slice(0, 10) ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, businessStartDate: e.target.value || null })
                    }
                  />
                </Field>
                <Field label="Immatriculation RNE">
                  <Input
                    type="date"
                    value={form.rneRegistrationDate?.slice(0, 10) ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, rneRegistrationDate: e.target.value || null })
                    }
                  />
                </Field>
                <Field label="Enveloppe trésorerie (bps)">
                  <Input
                    type="number"
                    value={form.treasuryRateBps}
                    onChange={(e) =>
                      setForm({ ...form, treasuryRateBps: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="Enveloppe placements (bps)">
                  <Input
                    type="number"
                    value={form.placementRateBps}
                    onChange={(e) =>
                      setForm({ ...form, placementRateBps: Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.b2cActivity}
                  onChange={(e) => setForm({ ...form, b2cActivity: e.target.checked })}
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
              <SaveBar onSave={saveDeclarations} />
            </Card>
          ) : null}

          {tab === "legal" ? (
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
                      <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--muted)]">{c.body}</p>
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
          ) : null}
        </div>
      </div>

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

function PayoutBeneficiaryCard() {
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const [label, setLabel] = useState("Compte personnel");
  const [name, setName] = useState("");
  const [iban, setIban] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PayoutStatus>("/api/payouts/status")
      .then(setStatus)
      .catch(() => setStatus(null));
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
      setStatus(await api("/api/payouts/status"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <Card className="space-y-4 border border-[var(--border)] p-5">
      <h3 className="text-sm font-semibold">Virement de rémunération (Business API)</h3>
      <p className="text-sm text-[var(--muted)]">
        {status.hasBeneficiary
          ? `Compte enregistré : ${status.beneficiaryLabel}. Titulaire et IBAN chiffrés.`
          : "Aucun compte enregistré."}
      </p>
      {!status.enabled ? (
        <p className="text-sm text-[var(--warning)]">
          Fonction désactivée :{" "}
          <code className="rounded bg-[var(--surface-raised)] px-1">REVOLUT_PAYOUT_ENABLED=true</code>{" "}
          dans le .env.
        </p>
      ) : null}
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        <Field label="Libellé">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
        <Field label="Titulaire">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="IBAN">
          <Input value={iban} onChange={(e) => setIban(e.target.value)} required />
        </Field>
        <div className="flex items-end justify-end sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Enregistrement…" : status.hasBeneficiary ? "Remplacer" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
