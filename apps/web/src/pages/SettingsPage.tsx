import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AddressAutocomplete, type AddressValue } from "@/components/forms/AddressAutocomplete";
import { SettingsTabNav } from "@/pages/settings/TabNav";
import { SecretField } from "@/pages/settings/SecretField";
import { SecurityTab } from "@/pages/settings/SecurityTab";
import { NotificationsTab } from "@/pages/settings/NotificationsTab";
import { EmailSignatureCard } from "@/pages/settings/EmailSignatureCard";
import {
  SETTINGS_TABS,
  type PublicSettings,
  type SettingsTabId,
} from "@/pages/settings/types";
import { useFeatures } from "@/lib/features";
import { fetchSettings } from "@/lib/settings-request";

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
  audience: ClauseAudience;
};

type ClauseAudience = "ALL" | "B2B" | "B2C";

const AUDIENCE_LABEL: Record<ClauseAudience, string> = {
  ALL: "Tous les clients",
  B2B: "Clients professionnels",
  B2C: "Clients particuliers",
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

type IdentitySection = "legal" | "contact" | "address" | "extra";

/** Champs de l'onglet Identité : libellé (toast) et section où l'erreur s'affiche. */
const IDENTITY_FIELDS: Record<string, { label: string; section: IdentitySection }> = {
  legalName: { label: "Nom légal", section: "legal" },
  tradeName: { label: "Nom commercial", section: "legal" },
  legalForm: { label: "Forme juridique", section: "legal" },
  rcsMention: { label: "RCS / RNE", section: "legal" },
  siren: { label: "SIREN", section: "legal" },
  siret: { label: "SIRET", section: "legal" },
  apeCode: { label: "APE", section: "legal" },
  vatIntraNumber: { label: "N° TVA intracom", section: "legal" },
  email: { label: "Email de contact", section: "contact" },
  phone: { label: "Téléphone", section: "contact" },
  website: { label: "Site web", section: "contact" },
  clientPortalUrl: { label: "URL du portail client", section: "contact" },
  googleReviewUrl: { label: "Lien vers le formulaire d'avis", section: "contact" },
  addressLine1: { label: "Adresse", section: "address" },
  addressLine2: { label: "Complément d'adresse", section: "address" },
  postalCode: { label: "Code postal", section: "address" },
  city: { label: "Ville", section: "address" },
  decennaleInsurer: { label: "Décennale : assureur", section: "extra" },
  decennalePolicyNumber: { label: "N° de police", section: "extra" },
  decennaleCoverageZone: { label: "Zone de couverture", section: "extra" },
};

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
  const tabParam = params.get("tab");
  const tab: SettingsTabId = isTab(tabParam) ? tabParam : "general";
  const setTab = (id: SettingsTabId) => {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    setParams(next, { replace: true });
  };
  const { refresh: refreshFeatures } = useFeatures();

  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<PublicSettings | null>(null);
  const [smtpPass, setSmtpPass] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [requireSmtpPass, setRequireSmtpPass] = useState(false);
  const [stripeKey, setStripeKey] = useState("");
  const [stripeWebhook, setStripeWebhook] = useState("");
  // Compte de versement lu dans Stripe (dernier versement) ; texte générique s'il est inconnu.
  const [payoutAccount, setPayoutAccount] = useState<{ bankName: string | null; last4: string } | null>(null);
  useEffect(() => {
    if (!form?.moduleStripeEnabled) return;
    api<{ destination: { bankName: string | null; last4: string } | null }>("/api/stripe/payouts/preview")
      .then((p) => setPayoutAccount(p.destination))
      .catch(() => setPayoutAccount(null));
  }, [form?.moduleStripeEnabled]);
  const [testEmailTo, setTestEmailTo] = useState("");
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [clauses, setClauses] = useState<LegalClause[] | null>(null);
  const [previews, setPreviews] = useState<NumberingPreview[]>([]);
  const [audit, setAudit] = useState<NumberingAudit | null>(null);
  const [busy, setBusy] = useState(false);
  const [inpiQuery, setInpiQuery] = useState("");
  const [clauseModal, setClauseModal] = useState<LegalClause | "new" | null>(null);
  const [clauseToDelete, setClauseToDelete] = useState<LegalClause | null>(null);
  const [clauseDeleting, setClauseDeleting] = useState(false);
  const [clauseForm, setClauseForm] = useState<{ title: string; body: string; kind: string; audience: ClauseAudience }>({
    title: "",
    body: "",
    kind: "CUSTOM",
    audience: "ALL",
  });
  const [imapTest, setImapTest] = useState<string | null>(null);
  // ?section=contact (lien du tableau de bord quand l'e-mail de l'entreprise manque).
  const [identitySection, setIdentitySection] = useState<IdentitySection>(() => {
    const s = params.get("section");
    return s === "contact" || s === "address" || s === "extra" ? s : "legal";
  });
  // Erreur affichée tant que la valeur refusée n'a pas été modifiée.
  const [fieldErrors, setFieldErrors] = useState<Record<string, { message: string; value: string }>>({});
  const focusFirstError = useRef(false);
  const [googleStatus, setGoogleStatus] = useState<{
    configured: boolean;
    connected: boolean;
    email: string | null;
    reauthRequiredAt?: string | null;
  } | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const d = form?.emailDefaults;

  async function load() {
    // Le formulaire s'affiche dès l'arrivée des réglages : liste de contrôle, clauses, aperçus de
    // numérotation et Google Agenda (autres onglets) arrivent en parallèle sans retenir la page.
    const fail = (e: Error) => toast.error(e.message, { id: "settings-load" });
    api<Checklist>("/api/checklist").then(setChecklist).catch(fail);
    api<LegalClause[]>("/api/legal-clauses").then(setClauses).catch(fail);
    api<{ previews: NumberingPreview[] }>("/api/numbering/preview").then((p) => setPreviews(p.previews)).catch(fail);
    void loadGoogleStatus();
    const s = await fetchSettings<PublicSettings>();
    setSettings(s);
    setForm(withTwoDepositMilestones(s));
    setInpiQuery(s.inpiUrl || s.siren || "");
    setTestEmailTo(s.email || "");
    setSmtpPass("");
    setImapPass("");
    setStripeKey("");
    setStripeWebhook("");
  }

  async function loadGoogleStatus() {
    try {
      const st = await api<{
        configured: boolean;
        connected: boolean;
        email: string | null;
        reauthRequiredAt?: string | null;
      }>("/api/google/calendar/status");
      setGoogleStatus(st);
    } catch {
      setGoogleStatus(null);
    }
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  useEffect(() => {
    const google = params.get("google");
    if (!google) return;
    if (google === "ok") {
      const upserted = Number(params.get("upserted") ?? "0");
      const syncError = params.get("syncError") === "1";
      void loadGoogleStatus();
      if (params.get("sync") === "pending") {
        // Échéances ajoutées à l'agenda en arrière-plan (plusieurs appels Google par obligation).
        toast.success("Google Agenda connecté : vos échéances s'y ajoutent en arrière-plan, en quelques instants.");
      } else if (syncError) {
        toast.error(
          "Google Agenda connecté, mais la création des événements a échoué. Réessayez via Synchroniser maintenant.",
        );
      } else if (Number.isFinite(upserted) && upserted > 0) {
        toast.success(
          `Google Agenda connecté : ${upserted} événement(s) créé(s) / mis à jour`,
        );
      } else {
        toast.success(
          "Google Agenda connecté (aucune échéance ouverte à synchroniser)",
        );
      }
    } else if (google === "error") {
      toast.error("Connexion Google Agenda échouée");
    }
    const next = new URLSearchParams(params);
    next.delete("google");
    next.delete("upserted");
    next.delete("deleted");
    next.delete("syncError");
    next.delete("sync");
    setParams(next, { replace: true });
  }, [params, setParams]);

  async function connectGoogleCalendar() {
    setGoogleBusy(true);
    try {
      const { url } = await api<{ url: string }>(
        `/api/google/calendar/auth-url?returnTo=${encodeURIComponent(window.location.origin)}`,
      );
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Impossible d'ouvrir Google");
      setGoogleBusy(false);
    }
  }

  async function disconnectGoogleCalendar() {
    setGoogleBusy(true);
    try {
      await api("/api/google/calendar/disconnect", { method: "POST" });
      toast.success("Google Agenda déconnecté");
      await loadGoogleStatus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Déconnexion échouée");
    } finally {
      setGoogleBusy(false);
    }
  }

  async function syncGoogleCalendar() {
    setGoogleBusy(true);
    try {
      const res = await api<{ upserted: number; deleted: number; skipped: boolean }>(
        "/api/google/calendar/sync",
        { method: "POST" },
      );
      if (res.skipped) {
        toast.message("Google Agenda non connecté");
      } else {
        toast.success(
          `Agenda synchronisé : ${res.upserted} événement(s), ${res.deleted} supprimé(s)`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync échouée");
    } finally {
      setGoogleBusy(false);
    }
  }
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
      addressManualConfirmed: false,
    };
  }, [form]);

  const [modeChange, setModeChange] = useState<{ path: string; body: Record<string, unknown>; message: string } | null>(
    null,
  );

  async function save(path: string, body: unknown) {
    setBusy(true);
    try {
      const updated = await api<PublicSettings>(path, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSettings(updated);
      setForm(withTwoDepositMilestones(updated));
      setSmtpPass("");
      setImapPass("");
      setStripeKey("");
      setStripeWebhook("");
      setFieldErrors({});
      if (path.includes("/payments")) {
        await refreshFeatures();
      }
      toast.success("Enregistré");
      if (path.includes("numbering") || body && typeof body === "object" && "invoiceNumberTemplate" in (body as object)) {
        const prev = await api<{ previews: NumberingPreview[] }>("/api/numbering/preview");
        setPreviews(prev.previews);
      }
    } catch (e) {
      // Clé Stripe d'un autre mode (test ou live) : confirmation explicite avant d'enregistrer.
      if ((e as { code?: string }).code === "stripe_mode_change" && body && typeof body === "object") {
        setModeChange({ path, body: body as Record<string, unknown>, message: (e as Error).message });
        return;
      }
      const errors = (e as { fieldErrors?: Record<string, string> }).fieldErrors;
      const sent = (body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(errors ?? {}).filter((k) => k in IDENTITY_FIELDS);
      if (errors && keys.length) {
        setFieldErrors(
          Object.fromEntries(keys.map((k) => [k, { message: errors[k]!, value: String(sent[k] ?? "") }])),
        );
        setIdentitySection(IDENTITY_FIELDS[keys[0]!]!.section);
        focusFirstError.current = true;
        toast.error(`Vérifiez : ${keys.map((k) => IDENTITY_FIELDS[k]!.label).join(", ")}.`);
        return;
      }
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  // Après un refus : focus sur le premier champ en erreur, une fois la bonne section affichée.
  useEffect(() => {
    if (!focusFirstError.current || busy) return;
    focusFirstError.current = false;
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fieldErrors, identitySection, busy]);

  function fieldError(key: string): string | undefined {
    const err = fieldErrors[key];
    const current = form ? String((form as unknown as Record<string, unknown>)[key] ?? "") : "";
    return err && current === err.value ? err.message : undefined;
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
      reviewInviteEnabled: form.reviewInviteEnabled,
      googleReviewUrl: form.googleReviewUrl,
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
      transactionalFrom: form.transactionalFrom || null,
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
      stripeSecretKey: stripeKey || undefined,
      stripeWebhookSecret: stripeWebhook || undefined,
      depositCount: 2,
      depositPercent1Bps: form.depositPercent1Bps,
      depositPercent2Bps: form.depositPercent2Bps,
      depositPercent3Bps: 0,
      split3Percent1Bps: form.split3Percent1Bps,
      split3Percent2Bps: form.split3Percent2Bps,
      split3Percent3Bps: form.split3Percent3Bps,
      split3MinTotalCents: form.split3MinTotalCents,
      paymentChoiceDefault: form.paymentChoiceDefault,
      split3Step2TriggerText: form.split3Step2TriggerText,
      paymentButtonLeadDays: form.paymentButtonLeadDays,
      annualFreeMonths: form.annualFreeMonths,
      moduleSubscriptionsEnabled: form.moduleSubscriptionsEnabled,
      moduleStripeEnabled: form.moduleStripeEnabled,
    });
  }

  async function saveReminders() {
    if (!form) return;
    await save("/api/settings/reminders", {
      reminderQuoteDays: form.reminderQuoteDays,
      reminderInvoiceDays: form.reminderInvoiceDays,
      nonRenewalNoticeDays: form.nonRenewalNoticeDays,
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
    });
  }

  async function saveMediation() {
    if (!form) return;
    await save("/api/settings/identity", { mediationClause: form.mediationClause?.trim() || null });
  }

  async function saveSalesTerms() {
    if (!form) return;
    await save("/api/settings/identity", {
      cgvPublished: form.cgvPublished,
      cgvUrl: form.cgvUrl?.trim() || null,
      cgvVersion: form.cgvVersion?.trim() || null,
      withdrawalExpressRequestText: form.withdrawalExpressRequestText.trim(),
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
      obligationReminderEmail: form.obligationReminderEmail,
      obligationEmailRemindersEnabled: form.obligationEmailRemindersEnabled,
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

  /** `fromOverride` : essai de l'expéditeur des e-mails automatiques (alias noreply@). */
  async function testSmtp(fromOverride?: string) {
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
          smtpFrom: fromOverride ?? form?.smtpFrom,
          smtpPass: smtpPass || undefined,
        }),
      });
      const via =
        res.source === "draft"
          ? " (valeurs du formulaire)"
          : res.source === "db"
            ? " (paramètres enregistrés)"
            : "";
      toast.success(
        fromOverride
          ? `Email de test envoyé à ${res.to} depuis ${fromOverride} : vérifiez l'expéditeur reçu.`
          : `Email de test envoyé à ${res.to}${via}`,
      );
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

  async function testStripe() {
    setBusy(true);
    try {
      // Clé saisie testée avant d'être enregistrée ; champ vide : la clé enregistrée.
      const res = await api<{ ok: boolean; mode: string; tested: string }>("/api/settings/payments/test-stripe", {
        method: "POST",
        body: JSON.stringify(stripeKey.trim() ? { secretKey: stripeKey } : {}),
      });
      toast.success(
        res.tested === "saisie"
          ? `Clé saisie acceptée par Stripe (mode ${res.mode}). Enregistrez pour l'utiliser.`
          : `Stripe OK (clé enregistrée, mode ${res.mode})`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec Stripe");
    } finally {
      setBusy(false);
    }
  }

  async function syncStripeCatalog() {
    setBusy(true);
    try {
      const res = await api<{
        ok: boolean;
        actions: Array<{ action: string }>;
      }>("/api/settings/payments/sync-catalog", { method: "POST", body: "{}" });
      const created = res.actions.filter((a) => a.action === "create").length;
      const updated = res.actions.filter((a) => a.action === "update").length;
      const archived = res.actions.filter((a) => a.action === "archive").length;
      toast.success(
        `Catalogue synchronisé (${created} créé·s, ${updated} mis à jour, ${archived} archivé·s)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec synchronisation");
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
            audience: clauseForm.audience,
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
    setClauseDeleting(true);
    try {
      await api(`/api/legal-clauses/${id}`, { method: "DELETE" });
      setClauses(await api("/api/legal-clauses"));
      setClauseToDelete(null);
      toast.success("Clause supprimée");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setClauseDeleting(false);
    }
  }

  async function copyWebhook() {
    if (!form) return;
    try {
      await navigator.clipboard.writeText(form.stripeWebhookUrl);
      toast.success("URL copiée");
    } catch {
      toast.error("Copie impossible");
    }
  }

  if (!form || !settings) {
    return <p className="text-sm text-[var(--muted)]">Chargement…</p>;
  }

  // Appelée comme une fonction, pas comme un composant déclaré dans le rendu : le bouton n'est pas
  // remonté à chaque rendu et garde le focus.
  const saveBar = (onSave: () => void) => (
    <div className="sticky bottom-0 mt-4 flex justify-end border-t border-[var(--border)] bg-[var(--surface)] pt-4 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <Button type="button" disabled={busy} onClick={() => void onSave()} className="w-full sm:w-auto">
        {busy ? "Enregistrement…" : "Enregistrer cet onglet"}
      </Button>
    </div>
  );

  const identitySections = [
    { id: "legal" as const, label: "Entreprise" },
    { id: "contact" as const, label: "Contacts" },
    { id: "address" as const, label: "Adresse" },
    { id: "extra" as const, label: "Assurance & suivi" },
  ];

  return (
    <div>
      <PageHeader
        title="Réglages"
        subtitle="Entreprise, facturation et communication. Chaque section s'enregistre séparément."
        actions={busy ? <span className="text-xs text-[var(--muted)]">Enregistrement…</span> : null}
      />

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <SettingsTabNav active={tab} onChange={setTab} />

        <div className="min-w-0 flex-1 space-y-4">
          {tab === "general" ? (
            <Card className="space-y-5 border border-[var(--border)] p-5">
              <div>
                <h2 className="text-base font-semibold">Identité de l&apos;entreprise</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  SIREN, adresse, contacts. Utilisé sur les PDF et le portail client.
                </p>
              </div>
              <div role="group" aria-label="Sous-sections" className="-mx-5 flex gap-1 overflow-x-auto border-b border-[var(--border)] px-5 no-scrollbar">
                {identitySections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setIdentitySection(s.id)}
                    aria-pressed={identitySection === s.id}
                    className={`-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm transition-colors ${
                      identitySection === s.id
                        ? "border-[var(--primary)] font-medium text-[var(--text)]"
                        : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {identitySection === "legal" ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="min-w-[15rem] flex-1"
                      placeholder="SIREN ou URL data.inpi.fr/entreprises/…"
                      value={inpiQuery}
                      onChange={(e) => setInpiQuery(e.target.value)}
                    />
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => void importInpi()}>
                      Importer INPI / open data
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Nom légal" error={fieldError("legalName")}>
                      <Input
                        value={form.legalName}
                        onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                      />
                    </Field>
                    <Field label="Nom commercial" error={fieldError("tradeName")}>
                      <Input
                        value={form.tradeName ?? ""}
                        onChange={(e) => setForm({ ...form, tradeName: e.target.value || null })}
                      />
                    </Field>
                    <Field label="Forme juridique" error={fieldError("legalForm")}>
                      <Input
                        placeholder="EI"
                        value={form.legalForm ?? ""}
                        onChange={(e) => setForm({ ...form, legalForm: e.target.value || null })}
                      />
                    </Field>
                    <Field label="RCS / RNE" error={fieldError("rcsMention")}>
                      <Input
                        placeholder="RNE / non inscrit RCS"
                        value={form.rcsMention ?? ""}
                        onChange={(e) => setForm({ ...form, rcsMention: e.target.value || null })}
                      />
                    </Field>
                    <Field label="SIREN" error={fieldError("siren")}>
                      <Input value={form.siren} onChange={(e) => setForm({ ...form, siren: e.target.value })} />
                    </Field>
                    <Field label="SIRET" error={fieldError("siret")}>
                      <Input value={form.siret} onChange={(e) => setForm({ ...form, siret: e.target.value })} />
                    </Field>
                    <Field label="APE" error={fieldError("apeCode")}>
                      <Input value={form.apeCode} onChange={(e) => setForm({ ...form, apeCode: e.target.value })} />
                    </Field>
                    <Field label="N° TVA intracom" error={fieldError("vatIntraNumber")}>
                      <Input
                        placeholder="Franchise de base : laisser vide"
                        value={form.vatIntraNumber ?? ""}
                        onChange={(e) => setForm({ ...form, vatIntraNumber: e.target.value || null })}
                      />
                    </Field>
                  </div>
                </div>
              ) : null}

              {identitySection === "contact" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Email de contact" error={fieldError("email")}>
                    <Input
                      type="email"
                      value={form.email ?? ""}
                      onChange={(e) => setForm({ ...form, email: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Téléphone" error={fieldError("phone")}>
                    <Input
                      value={form.phone ?? ""}
                      onChange={(e) => setForm({ ...form, phone: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Site web" error={fieldError("website")}>
                    <Input
                      value={form.website ?? ""}
                      onChange={(e) => setForm({ ...form, website: e.target.value || null })}
                    />
                  </Field>
                  <Field label="URL du portail client" error={fieldError("clientPortalUrl")}>
                    <Input
                      placeholder="https://kouzia.com/suivi/"
                      value={form.clientPortalUrl ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, clientPortalUrl: e.target.value || null })
                      }
                    />
                  </Field>
                  <fieldset className="space-y-3 sm:col-span-2">
                    <legend className="mb-1 text-sm font-semibold">Avis Google</legend>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.reviewInviteEnabled}
                        onChange={(e) => setForm({ ...form, reviewInviteEnabled: e.target.checked })}
                      />
                      Inviter le client à laisser un avis quand son projet est livré
                    </label>
                    <Field
                      label="Lien vers le formulaire d'avis"
                      error={fieldError("googleReviewUrl")}
                      hint="Envoyé par e-mail (depuis l'adresse noreply) au passage d'un projet à « Terminé », une seule fois par projet, et proposé dans l'espace client."
                    >
                      <Input
                        type="url"
                        inputMode="url"
                        placeholder="https://g.page/r/.../review"
                        value={form.googleReviewUrl ?? ""}
                        disabled={!form.reviewInviteEnabled}
                        onChange={(e) => setForm({ ...form, googleReviewUrl: e.target.value || null })}
                      />
                    </Field>
                  </fieldset>
                </div>
              ) : null}

              {identitySection === "address" ? (
                addressValue ? (
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
                ) : null
              ) : null}
              {identitySection === "address"
                ? (["addressLine1", "addressLine2", "postalCode", "city"] as const)
                    .filter((k) => fieldError(k))
                    .map((k) => (
                      <p key={k} role="alert" className="text-sm text-[var(--danger)]">
                        {fieldError(k)}
                      </p>
                    ))
                : null}

              {identitySection === "extra" ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <Field label="Décennale : assureur" error={fieldError("decennaleInsurer")}>
                      <Input
                        value={form.decennaleInsurer ?? ""}
                        onChange={(e) => setForm({ ...form, decennaleInsurer: e.target.value || null })}
                      />
                    </Field>
                    <Field label="N° de police" error={fieldError("decennalePolicyNumber")}>
                      <Input
                        value={form.decennalePolicyNumber ?? ""}
                        onChange={(e) =>
                          setForm({ ...form, decennalePolicyNumber: e.target.value || null })
                        }
                      />
                    </Field>
                    <Field label="Zone de couverture" error={fieldError("decennaleCoverageZone")}>
                      <Input
                        value={form.decennaleCoverageZone ?? ""}
                        onChange={(e) =>
                          setForm({ ...form, decennaleCoverageZone: e.target.value || null })
                        }
                      />
                    </Field>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.publicTrackingShowAmounts}
                      onChange={(e) =>
                        setForm({ ...form, publicTrackingShowAmounts: e.target.checked })
                      }
                    />
                    Afficher les montants sur le suivi public client
                  </label>
                </div>
              ) : null}

              {saveBar(saveGeneral)}
            </Card>
          ) : null}

          {tab === "email" ? <EmailSignatureCard /> : null}
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
                    className="text-xs"
                    onClick={() => applyMailPreset("hostinger")}
                  >
                    Config Hostinger
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="text-xs"
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
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  <Field
                    label="Expéditeur des e-mails automatiques"
                    hint="Codes de connexion, invitation, accès à l'espace client, alertes. Ex. noreply@kouzia.com ; les réponses vont au Reply-To. Vide : même expéditeur que les documents."
                    className="sm:col-span-2"
                  >
                    <Input
                      type="email"
                      autoComplete="off"
                      placeholder="noreply@kouzia.com"
                      value={form.transactionalFrom ?? ""}
                      onChange={(e) => setForm({ ...form, transactionalFrom: e.target.value || null })}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Button
                      variant="secondary"
                      disabled={busy || !form.transactionalFrom}
                      onClick={() => void testSmtp(form.transactionalFrom ?? undefined)}
                    >
                      Envoyer un e-mail de test depuis cette adresse
                    </Button>
                  </div>
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
                  <Field label="Adresse de test" className="min-w-[13.75rem] flex-1">
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
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  <Field label="Intervalle de polling (min)" hint="1 à 60. Avec IDLE IMAP actif, les mails arrivent en quasi temps réel.">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={form.imapPollIntervalMinutes}
                      onChange={(e) =>
                        setForm({ ...form, imapPollIntervalMinutes: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
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
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              {saveBar(saveEmail)}
            </Card>
          ) : null}

          {tab === "payments" ? (
            <div className="space-y-4">
              <Card className="space-y-4 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Modules affichés</h3>
                <p className="text-xs text-[var(--muted)]">
                  Masquez ce que vous n&apos;utilisez pas. Les clients, devis, factures et mails
                  restent toujours disponibles.
                </p>
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.moduleSubscriptionsEnabled ?? true}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        moduleSubscriptionsEnabled: e.target.checked,
                      })
                    }
                  />
                  <span>
                    <span className="font-medium">Abonnements / maintenance</span>
                    <span className="mt-0.5 block text-xs text-[var(--muted)]">
                      Contrats récurrents, facturés au mois ou à l&apos;année.
                    </span>
                  </span>
                </label>
                {form.moduleSubscriptionsEnabled ?? true ? (
                  <Field
                    label="Abonnement annuel : mois offerts"
                    hint={`Montant annuel proposé = prix mensuel × ${12 - (form.annualFreeMonths ?? 2)}. Modifiable contrat par contrat.`}
                    className="sm:max-w-xs"
                  >
                    <Input
                      type="number"
                      min={0}
                      max={6}
                      inputMode="numeric"
                      value={form.annualFreeMonths ?? 2}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          annualFreeMonths: Math.min(6, Math.max(0, Math.round(Number(e.target.value) || 0))),
                        })
                      }
                    />
                  </Field>
                ) : null}
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.moduleStripeEnabled ?? false}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        moduleStripeEnabled: e.target.checked,
                      })
                    }
                  />
                  <span>
                    <span className="font-medium">Paiements Stripe</span>
                    <span className="mt-0.5 block text-xs text-[var(--muted)]">
                      Liens de paiement automatiques (carte, virement, prélèvement SEPA) et
                      synchronisation du catalogue. L&apos;argent est versé sur{" "}
                      {payoutAccount
                        ? `le compte ${payoutAccount.bankName ? `${payoutAccount.bankName} ` : ""}se terminant par ${payoutAccount.last4}`
                        : "le compte bancaire enregistré dans Stripe"}
                      .
                    </span>
                  </span>
                </label>
              </Card>

              {!form.moduleStripeEnabled ? (
                <Card className="space-y-2 border border-[var(--border)] bg-[var(--primary-soft)]/40 p-5">
                  <h3 className="text-sm font-semibold">Paiements B2B (pro, restos, assos)</h3>
                  <p className="text-xs leading-relaxed text-[var(--muted)]">
                    Sans Stripe, le plus simple reste le{" "}
                    <strong className="text-[var(--text)]">virement SEPA</strong> sur
                    l&apos;IBAN du compte pro (affiché sur le PDF). Référence = n° de facture.
                  </p>
                  <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-[var(--muted)]">
                    <li>Devis dans l&apos;ERP → validation client sur /suivi.</li>
                    <li>Émettre la facture d&apos;acompte.</li>
                    <li>
                      Le client vire → vous voyez le crédit sur le compte pro →{" "}
                      <strong className="text-[var(--text)]">Marquer payé</strong> / enregistrer
                      l&apos;encaissement dans l&apos;ERP.
                    </li>
                    <li>Livraison → facture de solde, même logique.</li>
                  </ol>
                </Card>
              ) : null}

              <Card className="space-y-4 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Coordonnées bancaires (virement)</h3>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

              {form.moduleStripeEnabled ? (
              <Card className="space-y-4 border border-[var(--border)] p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">Stripe (encaissement en ligne)</h3>
                  {form.stripeMode === "live" ? (
                    <span className="rounded-full bg-[var(--warning-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--warning)]">
                      Mode live
                    </span>
                  ) : form.stripeMode === "test" ? (
                    <span className="rounded-full bg-[var(--info-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--info)]">
                      Mode test
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-[var(--muted)]">
                  Clés dans le tableau de bord Stripe. Le mode test ou live se déduit du préfixe
                  de la clé (<code className="text-[var(--text)]">sk_test_</code> /{" "}
                  <code className="text-[var(--text)]">sk_live_</code>).
                </p>
                <p
                  role="note"
                  className="rounded-[var(--radius-sm)] border border-[var(--warning)]/40 bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--text)]"
                >
                  Dans Stripe, désactivez l&apos;envoi des factures et des reçus aux clients
                  (Settings, Customer emails). La facture légale est celle de l&apos;ERP : sinon,
                  le client en recevrait deux.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <SecretField
                    label="Clé secrète"
                    value={stripeKey}
                    onChange={setStripeKey}
                    secret={form.secrets.stripeSecretKey}
                  />
                  <SecretField
                    label="Secret webhook"
                    value={stripeWebhook}
                    onChange={setStripeWebhook}
                    secret={form.secrets.stripeWebhookSecret}
                  />
                </div>
                <Field label="URL webhook (à coller dans Stripe)">
                  <div className="flex gap-2">
                    <Input readOnly value={form.stripeWebhookUrl} />
                    <Button type="button" variant="secondary" onClick={() => void copyWebhook()}>
                      Copier
                    </Button>
                  </div>
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => void testStripe()}>
                    Tester la connexion
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void syncStripeCatalog()}
                  >
                    Synchroniser le catalogue
                  </Button>
                </div>
              </Card>
              ) : null}

              <Card className="space-y-4 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Paiement en 2 fois</h3>
                <p className="text-xs text-[var(--muted)]">
                  Un acompte à la validation du devis, puis le solde à la livraison. Les devis
                  déjà émis conservent leur échéancier.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

                <h3 className="border-t border-[var(--border)] pt-4 text-sm font-semibold">Paiement en 3 fois</h3>
                <p className="text-xs text-[var(--muted)]">
                  Acompte à la validation, 2e acompte quand l&apos;étape de projet choisie est faite,
                  solde à la livraison. La formule se choisit devis par devis ; le client peut aussi
                  choisir à la signature.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Acompte (%)">
                    <Input
                      type="number"
                      min={1}
                      max={98}
                      value={pct(form.split3Percent1Bps)}
                      onChange={(e) => {
                        const p1 = fromPct(e.target.value);
                        setForm({
                          ...form,
                          split3Percent1Bps: p1,
                          split3Percent3Bps: Math.max(0, 10000 - p1 - form.split3Percent2Bps),
                        });
                      }}
                    />
                  </Field>
                  <Field label="2e acompte (%)">
                    <Input
                      type="number"
                      min={1}
                      max={98}
                      value={pct(form.split3Percent2Bps)}
                      onChange={(e) => {
                        const p2 = fromPct(e.target.value);
                        setForm({
                          ...form,
                          split3Percent2Bps: p2,
                          split3Percent3Bps: Math.max(0, 10000 - form.split3Percent1Bps - p2),
                        });
                      }}
                    />
                  </Field>
                  <Field label="Solde (%)" hint="Calculé : le total fait 100 %">
                    <Input type="number" readOnly value={pct(form.split3Percent3Bps)} />
                  </Field>
                  <Field label="3 fois à partir de (€)" hint="En dessous, le devis passe en 2 fois">
                    <Input
                      type="number"
                      min={0}
                      step="1"
                      inputMode="numeric"
                      value={String(Math.round(form.split3MinTotalCents / 100))}
                      onChange={(e) =>
                        setForm({ ...form, split3MinTotalCents: Math.max(0, Math.round(Number(e.target.value) * 100)) })
                      }
                    />
                  </Field>
                  <Field label="Texte du 2e acompte sur le devis" className="sm:col-span-2">
                    <Input
                      maxLength={200}
                      value={form.split3Step2TriggerText}
                      onChange={(e) => setForm({ ...form, split3Step2TriggerText: e.target.value })}
                    />
                  </Field>
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.paymentChoiceDefault}
                    onChange={(e) => setForm({ ...form, paymentChoiceDefault: e.target.checked })}
                  />
                  Nouveaux devis : laisser le client choisir entre 2 et 3 fois
                </label>
                {saveBar(savePayments)}
              </Card>
            </div>
          ) : null}

          {tab === "reminders" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <h3 className="text-sm font-semibold">Relances devis / factures</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <h3 className="pt-2 text-sm font-semibold">Reconduction des abonnements annuels</h3>
              <Field
                label="Date limite pour refuser la reconduction (jours avant le renouvellement)"
                hint="1 = la veille. L'e-mail d'information part 45 jours avant cette date, pour tous les abonnements annuels."
              >
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={form.nonRenewalNoticeDays}
                  onChange={(e) => setForm({ ...form, nonRenewalNoticeDays: Number(e.target.value) })}
                />
              </Field>
              <h3 className="pt-2 text-sm font-semibold">Rappels d&apos;acomptes</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                      <label className="flex min-h-11 min-w-11 items-center justify-center text-sm">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          aria-label={`Activer le rappel ${label}`}
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
              {saveBar(saveReminders)}
            </Card>
          ) : null}

          {tab === "identity" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Couleur primaire">
                  <div className="flex gap-2">
                    <input
                      type="color"
                      className="h-11 w-14 cursor-pointer rounded border border-[var(--border)] bg-transparent"
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
                      className="h-11 w-14 cursor-pointer rounded border border-[var(--border)] bg-transparent"
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
                      className="h-16 max-w-[10rem] object-contain"
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
              <Field label="Pied de page PDF">
                <Textarea
                  rows={2}
                  value={form.pdfFooterText ?? ""}
                  onChange={(e) => setForm({ ...form, pdfFooterText: e.target.value || null })}
                />
              </Field>
              <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--muted)]">
                Mentions TVA, paiement, pénalités : onglet{" "}
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center font-medium text-[var(--primary)] hover:underline"
                  onClick={() => setTab("legal")}
                >
                  Mentions légales
                </button>
                .
              </p>
              {saveBar(saveIdentity)}
            </Card>
          ) : null}

          {tab === "numbering" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <p className="text-xs text-[var(--muted)]">
                Variables : {"{prefix}"}, {"{year}"}, {"{counter}"}. Attribution uniquement à
                l&apos;émission.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              {saveBar(saveNumbering)}
            </Card>
          ) : null}

          {tab === "declarations" ? (
            <Card className="space-y-4 border border-[var(--border)] p-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.b2cActivity}
                  onChange={(e) => setForm({ ...form, b2cActivity: e.target.checked })}
                />
                Je facture des particuliers (rappel médiation)
              </label>

              <div className="space-y-3 border-t border-[var(--border)] pt-4">
                <div>
                  <p className="text-sm font-medium">Google Agenda</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    À la connexion (et via Synchroniser), Kouzia recalcule les
                    obligations ouvertes puis crée deux événements Google par
                    démarche : ouverture de la fenêtre et échéance / clôture (9h
                    Europe/Paris, rappels J-7, J-3, J-1, jour J sur l&apos;échéance).
                    Les emails de rappel (ci-dessous) sont indépendants de Google.
                  </p>
                </div>
                {googleStatus?.configured && !googleStatus.connected && googleStatus.reauthRequiredAt ? (
                  <div
                    role="alert"
                    className="rounded-[var(--radius)] border border-[var(--warning)] bg-[var(--warning-soft)] px-4 py-3 text-sm text-[var(--text)]"
                  >
                    <p className="font-medium">Google Agenda à reconnecter</p>
                    <p className="mt-1">
                      Le {formatDate(googleStatus.reauthRequiredAt)}, Google a refusé l&apos;accès
                      {googleStatus.email ? ` de ${googleStatus.email}` : ""} (autorisation expirée ou
                      révoquée). Les événements des démarches ne sont plus mis à jour : reconnectez le compte.
                    </p>
                  </div>
                ) : null}
                <p className="text-sm">
                  {googleStatus == null
                    ? "Statut inconnu"
                    : !googleStatus.configured
                      ? "Non configuré côté serveur (GOOGLE_CLIENT_ID / SECRET)"
                      : googleStatus.connected
                        ? `Connecté${googleStatus.email ? ` : ${googleStatus.email}` : ""}`
                        : "Non connecté"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {googleStatus?.configured && !googleStatus.connected ? (
                    <Button
                      type="button"
                      disabled={googleBusy}
                      onClick={() => void connectGoogleCalendar()}
                    >
                      Connecter Google Agenda
                    </Button>
                  ) : null}
                  {googleStatus?.connected ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={googleBusy}
                        onClick={() => void syncGoogleCalendar()}
                      >
                        Synchroniser maintenant
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={googleBusy}
                        onClick={() => void disconnectGoogleCalendar()}
                      >
                        Déconnecter
                      </Button>
                    </>
                  ) : null}
                </div>
                <Field label="Email rappels déclarations">
                  <Input
                    type="email"
                    value={form.obligationReminderEmail}
                    onChange={(e) =>
                      setForm({ ...form, obligationReminderEmail: e.target.value })
                    }
                  />
                </Field>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.obligationEmailRemindersEnabled}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        obligationEmailRemindersEnabled: e.target.checked,
                      })
                    }
                  />
                  Envoyer des emails de rappel (J-7, J-3, J-1, jour J)
                </label>
              </div>

              {checklist ? (
                <div className="border-t border-[var(--border)] pt-4">
                  <p className="mb-2 text-sm font-medium">Checklist post-création</p>
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {CHECKLIST_LABELS.map(({ key, label }) => (
                      <li key={key}>
                        <label className="flex min-h-11 items-center gap-2 text-sm">
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
              {saveBar(saveDeclarations)}
            </Card>
          ) : null}

          {tab === "notifications" ? <NotificationsTab /> : null}
          {tab === "security" ? <SecurityTab /> : null}

          {tab === "legal" ? (
            <section className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">Mentions légales (PDF)</h2>
                  <p className="mt-1 max-w-xl text-xs text-[var(--muted)]">
                    Affichées en bas des devis et factures. La clause sur la facturation
                    électronique EI (jusqu&apos;au 1er sept. 2027) est ajoutée automatiquement
                    au démarrage si absente.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-3 text-xs"
                  onClick={() => {
                    setClauseForm({ title: "", body: "", kind: "CUSTOM", audience: "ALL" });
                    setClauseModal("new");
                  }}
                >
                  Ajouter
                </Button>
              </div>
              <Card className="divide-y divide-[var(--border)] border border-[var(--border)]" aria-busy={clauses === null || undefined}>
                {clauses === null ? <p className="p-4 text-sm text-[var(--muted)]">Chargement des clauses…</p> : null}
                {(clauses ?? []).map((c) => (
                  <div key={c.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {c.title}
                        {c.required ? (
                          <span className="ml-2 text-xs text-[var(--muted)]">obligatoire</span>
                        ) : null}
                      </p>
                      {c.audience !== "ALL" ? (
                        <p className="mt-0.5 text-xs font-medium text-[var(--primary)]">
                          {AUDIENCE_LABEL[c.audience]} seulement
                        </p>
                      ) : null}
                      <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--muted)]">{c.body}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-2 text-xs"
                        onClick={() => {
                          setClauseForm({ title: c.title, body: c.body, kind: c.kind, audience: c.audience });
                          setClauseModal(c);
                        }}
                      >
                        Modifier
                      </Button>
                      {!c.required ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="px-2 text-xs text-[var(--danger)]"
                          onClick={() => setClauseToDelete(c)}
                        >
                          Supprimer
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </Card>
              <Card className="space-y-3 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Médiation de la consommation</h3>
                <Field
                  label="Mention du médiateur"
                  hint="Nom, site et adresse du médiateur auquel vous avez adhéré. Imprimée sur les devis et factures des clients particuliers."
                >
                  <Textarea
                    rows={3}
                    maxLength={1000}
                    value={form.mediationClause ?? ""}
                    onChange={(e) => setForm({ ...form, mediationClause: e.target.value || null })}
                  />
                </Field>
                {!form.mediationClause?.trim() ? (
                  <p className="rounded-[var(--radius-sm)] border border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--text)]">
                    Aucun médiateur renseigné. Il est obligatoire dès que vous facturez des particuliers.
                  </p>
                ) : null}
                {saveBar(saveMediation)}
              </Card>
              <Card className="space-y-3 border border-[var(--border)] p-5">
                <h3 className="text-sm font-semibold">Conditions générales de vente et rétractation</h3>
                <Field
                  label="Adresse des CGV"
                  hint="Page publique des conditions générales de vente."
                >
                  <Input
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    value={form.cgvUrl ?? ""}
                    onChange={(e) => setForm({ ...form, cgvUrl: e.target.value || null })}
                  />
                </Field>
                <Field label="Version en vigueur" hint="Date de mise en ligne, par exemple 2026-11-04.">
                  <Input
                    maxLength={40}
                    autoComplete="off"
                    value={form.cgvVersion ?? ""}
                    onChange={(e) => setForm({ ...form, cgvVersion: e.target.value || null })}
                  />
                </Field>
                <label className="flex min-h-11 items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.cgvPublished}
                    onChange={(e) => setForm({ ...form, cgvPublished: e.target.checked })}
                  />
                  <span>
                    CGV publiées sur le site
                    <span className="block text-xs text-[var(--muted)]">
                      Le client les accepte à la signature en ligne ; le lien et la version figurent sur les devis.
                    </span>
                  </span>
                </label>
                <Field
                  label="Case de démarrage anticipé (particuliers)"
                  hint="Proposée à la signature en ligne. Sans cette demande, la prestation et l'abonnement commencent après le délai de rétractation de 14 jours."
                >
                  <Textarea
                    rows={4}
                    maxLength={1000}
                    value={form.withdrawalExpressRequestText}
                    onChange={(e) => setForm({ ...form, withdrawalExpressRequestText: e.target.value })}
                  />
                </Field>
                {saveBar(saveSalesTerms)}
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
          <Field
            label="Texte"
            hint="Variables remplacées sur les PDF : {{nom_commercial}}, {{raison_sociale}}, {{adresse}}, {{email}}."
          >
            <Textarea
              required
              rows={4}
              value={clauseForm.body}
              onChange={(e) => setClauseForm({ ...clauseForm, body: e.target.value })}
            />
          </Field>
          <Field label="S'imprime pour" hint="Selon le type du client du devis ou de la facture.">
            <Select
              value={clauseForm.audience}
              onChange={(e) => setClauseForm({ ...clauseForm, audience: e.target.value as ClauseAudience })}
            >
              {(Object.keys(AUDIENCE_LABEL) as ClauseAudience[]).map((a) => (
                <option key={a} value={a}>
                  {AUDIENCE_LABEL[a]}
                </option>
              ))}
            </Select>
          </Field>
          <ModalActions>
            <Button type="button" variant="secondary" onClick={() => setClauseModal(null)}>
              Annuler
            </Button>
            <Button type="submit">Enregistrer</Button>
          </ModalActions>
        </form>
      </Modal>

      <ConfirmDialog
        open={clauseToDelete !== null}
        title="Supprimer la clause ?"
        message={`« ${clauseToDelete?.title ?? ""} » ne s'imprimera plus sur les PDF des devis et factures.`}
        confirmLabel="Supprimer"
        danger
        busy={clauseDeleting}
        onConfirm={() => clauseToDelete && void deleteClause(clauseToDelete.id)}
        onClose={() => setClauseToDelete(null)}
      />

      <ConfirmDialog
        open={Boolean(modeChange)}
        title="Changer de mode Stripe ?"
        message={modeChange?.message ?? ""}
        confirmLabel="Enregistrer cette clé"
        danger
        busy={busy}
        onConfirm={() => {
          if (!modeChange) return;
          const next = modeChange;
          setModeChange(null);
          void save(next.path, { ...next.body, confirmStripeModeChange: true });
        }}
        onClose={() => setModeChange(null)}
      />
    </div>
  );
}


