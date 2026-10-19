import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { uploadsPath } from "@/lib/uploads.js";
import { brandLogoCandidates, readBrandLogo } from "@/lib/pdf/brand-assets.js";
import { footerDuplicates, renderChartePreviewEmail, renderChartePreviewPdf } from "@/lib/pdf/charte-preview.js";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UrssafPeriodicity } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { parseBusinessStartDateInput, formatBusinessStartDateForApi } from "@/lib/company/business-start.js";
import { applyInpiImport } from "@/lib/company/inpi.js";
import { syncObligationsApresModification } from "@/lib/obligations/obligation-service.js";
import {
  isSmtpConfigured,
  testSmtpDelivery,
  formatSmtpError,
  getSmtpStatus,
  saveSmtpSettings,
  resolveSmtpConfig,
} from "@/lib/email/smtp.js";
import { testImapConnection } from "@/lib/email/imap-config.js";
import { SIGNATURE_HTML_MAX } from "@/lib/email/signature.js";
import { decryptOptional } from "@/lib/crypto.js";
import {
  saveGeneralTab,
  saveEmailTab,
  savePaymentsTab,
  saveRemindersTab,
  saveIdentityTab,
  saveDeclarationsTab,
  toPublicSettings,
  type AuditActor,
  type GeneralPatch,
  type DeclarationsPatch,
  type PaymentsPatch,
} from "@/lib/settings/service.js";
import { isSmtpEncryption } from "@/lib/settings/defaults.js";

function actorOf(request: { user?: { id: string; email: string } }): AuditActor {
  return {
    userId: request.user?.id ?? null,
    userEmail: request.user?.email ?? null,
  };
}

function serialize(settings: Awaited<ReturnType<typeof getCompanySettings>>) {
  const publicSettings = toPublicSettings(settings);
  return {
    ...publicSettings,
    businessStartDate: formatBusinessStartDateForApi(settings.businessStartDate),
    rneRegistrationDate: formatBusinessStartDateForApi(settings.rneRegistrationDate),
  };
}

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

// Onglet Identité : messages en français, affichés sous le champ concerné (fieldErrors).
// Champ facultatif vide accepté par refine : avec .or(z.literal("")), zod ne renverrait que « Invalid input ».
const required = (label: string) => z.string().trim().min(1, `${label} : champ obligatoire`);
const upTo = (max: number) => z.string().max(max, `${max} caractères au plus`).optional().nullable();
const emptyOr = (ok: (v: string) => boolean, message: string) =>
  z
    .string()
    .trim()
    .max(300, "300 caractères au plus")
    .refine((v) => v === "" || ok(v), { message })
    .optional()
    .nullable();
const isEmail = (v: string) => z.string().email().safeParse(v).success;
const isUrl = (v: string) => z.string().url().safeParse(v).success;
const isHttpsUrl = (v: string) => isUrl(v) && v.startsWith("https://");

/** Signature du fichier du logo : PNG, JPEG ou WebP, sinon null. */
function sniffLogo(buf: Buffer): "png" | "jpeg" | "webp" | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/settings", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return serialize(await getCompanySettings());
  });

  app.patch("/api/settings/general", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      legalName: required("Nom légal").optional(),
      tradeName: z.string().optional().nullable(),
      siren: z.string().trim().regex(/^\d{9}$/, "Le SIREN compte 9 chiffres").optional(),
      siret: z.string().trim().regex(/^\d{14}$/, "Le SIRET compte 14 chiffres").optional(),
      apeCode: required("Code APE").optional(),
      addressLine1: required("Adresse").optional(),
      addressLine2: z.string().optional().nullable(),
      postalCode: required("Code postal").optional(),
      city: required("Ville").optional(),
      country: z.string().optional(),
      email: emptyOr(isEmail, "Adresse e-mail invalide"),
      phone: z.string().optional().nullable(),
      website: z.string().optional().nullable(),
      legalForm: upTo(80),
      rcsMention: upTo(200),
      vatIntraNumber: upTo(20),
      decennaleInsurer: upTo(200),
      decennalePolicyNumber: upTo(80),
      decennaleCoverageZone: upTo(200),
      publicTrackingShowAmounts: z.boolean().optional(),
      reviewInviteEnabled: z.boolean().optional(),
      googleReviewUrl: emptyOr(isHttpsUrl, "Le lien d'avis doit être une adresse https:// complète"),
      clientPortalUrl: emptyOr(isUrl, "Adresse web complète attendue (https://…)"),
      inpiUrl: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const updated = await saveGeneralTab(parsed.data, actorOf(request));
    return serialize(updated);
  });

  app.patch("/api/settings/email", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      smtpHost: z.string().optional().nullable(),
      smtpPort: z.number().int().min(1).max(65535).optional().nullable(),
      smtpEncryption: z.enum(["SSL", "STARTTLS", "NONE"]).optional(),
      smtpUser: z.string().optional().nullable(),
      smtpPass: z.string().optional().nullable(),
      smtpFrom: z.string().optional().nullable(),
      smtpFromName: z.string().optional().nullable(),
      smtpReplyTo: z.string().optional().nullable(),
      transactionalFrom: z.string().trim().email().optional().nullable().or(z.literal("")),
      emailThrottlePerMinute: z.number().int().min(1).max(120).optional(),
      imapHost: z.string().optional().nullable(),
      imapPort: z.number().int().min(1).max(65535).optional().nullable(),
      imapSecure: z.boolean().optional(),
      imapUser: z.string().optional().nullable(),
      imapPass: z.string().optional().nullable(),
      imapMailbox: z.string().optional().nullable(),
      imapPollIntervalMinutes: z.number().int().min(1).max(60).optional(),
      attachmentMaxFileMb: z.number().int().min(1).max(200).optional(),
      attachmentMaxMessageMb: z.number().int().min(1).max(500).optional(),
      // Assainie avant enregistrement (saveEmailTab) ; chaîne vide ou null : signature par défaut.
      emailSignatureHtml: z
        .string()
        .max(SIGNATURE_HTML_MAX, `Signature trop longue (${SIGNATURE_HTML_MAX} caractères au plus)`)
        .optional()
        .nullable(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const updated = await saveEmailTab(
        {
          ...parsed.data,
          smtpEncryption: parsed.data.smtpEncryption && isSmtpEncryption(parsed.data.smtpEncryption)
            ? parsed.data.smtpEncryption
            : undefined,
        },
        actorOf(request),
      );
      return serialize(updated);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: e instanceof Error ? e.message : "Erreur" });
    }
  });

  app.post("/api/settings/email/test-smtp", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      to: z.string().email().optional(),
      smtpHost: z.string().optional().nullable(),
      smtpPort: z.number().int().min(1).max(65535).optional().nullable(),
      smtpEncryption: z.enum(["SSL", "STARTTLS", "NONE"]).optional().nullable(),
      smtpUser: z.string().optional().nullable(),
      smtpPass: z.string().optional().nullable(),
      smtpFrom: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const settings = await getCompanySettings();
    const cfg = await resolveSmtpConfig();
    const to =
      parsed.data.to?.trim() ||
      settings.email?.trim() ||
      cfg?.from?.match(/<([^>]+)>/)?.[1] ||
      cfg?.from ||
      "";
    if (!to) {
      return reply.code(400).send({ error: "Indiquez une adresse de test" });
    }
    try {
      const result = await testSmtpDelivery({
        to,
        draft: {
          smtpHost: parsed.data.smtpHost,
          smtpPort: parsed.data.smtpPort,
          smtpEncryption:
            parsed.data.smtpEncryption && isSmtpEncryption(parsed.data.smtpEncryption)
              ? parsed.data.smtpEncryption
              : undefined,
          smtpUser: parsed.data.smtpUser,
          smtpPass: parsed.data.smtpPass,
          smtpFrom: parsed.data.smtpFrom,
        },
      });
      return result;
    } catch (e) {
      return reply.code(400).send({
        error: formatSmtpError(e),
      });
    }
  });

  app.post("/api/settings/email/test-imap", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      imapHost: z.string().optional().nullable(),
      imapPort: z.number().optional().nullable(),
      imapSecure: z.boolean().optional().nullable(),
      imapUser: z.string().optional().nullable(),
      imapPass: z.string().optional().nullable(),
      imapMailbox: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await testImapConnection({
      draft: {
        imapHost: parsed.data.imapHost,
        imapPort: parsed.data.imapPort,
        imapSecure: parsed.data.imapSecure,
        imapUser: parsed.data.imapUser,
        imapPass: parsed.data.imapPass,
        imapMailbox: parsed.data.imapMailbox,
      },
    });
    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: result.error });
    }
    return result;
  });

  app.patch("/api/settings/payments", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      bankIban: z.string().max(34).optional().nullable(),
      bankBic: z.string().max(11).optional().nullable(),
      bankAccountHolder: z.string().max(200).optional().nullable(),
      bankName: z.string().max(120).optional().nullable(),
      stripeSecretKey: z.string().optional().nullable(),
      stripeWebhookSecret: z.string().optional().nullable(),
      confirmStripeModeChange: z.boolean().optional(),
      depositCount: z.number().int().min(2).max(2).optional(),
      depositPercent1Bps: z.number().int().min(0).max(10000).optional(),
      depositPercent2Bps: z.number().int().min(0).max(10000).optional(),
      depositPercent3Bps: z.number().int().min(0).max(10000).optional(),
      split3Percent1Bps: z.number().int().min(0).max(10000).optional(),
      split3Percent2Bps: z.number().int().min(0).max(10000).optional(),
      split3Percent3Bps: z.number().int().min(0).max(10000).optional(),
      split3MinTotalCents: z.number().int().min(0).max(100_000_000).optional(),
      paymentChoiceDefault: z.boolean().optional(),
      split3Step2TriggerText: z.string().trim().min(1).max(200).optional(),
      paymentButtonLeadDays: z.number().int().min(0).max(30).optional(),
      projectMilestoneMidBps: z.number().int().min(1000).max(9000).optional(),
      annualFreeMonths: z.number().int().min(0).max(6).optional(),
      paymentSepaEnabled: z.boolean().optional(),
      paymentCardEnabled: z.boolean().optional(),
      paymentCardMaxCents: z.number().int().min(0).max(10_000_000).optional(),
      moduleBankEnabled: z.boolean().optional(),
      moduleSubscriptionsEnabled: z.boolean().optional(),
      moduleStripeEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const updated = await savePaymentsTab(parsed.data, actorOf(request));
      return serialize(updated);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      // code « stripe_mode_change » : l'interface demande confirmation puis renvoie avec confirmStripeModeChange.
      const code = (e as { code?: string }).code;
      return reply.code(status).send({ error: e instanceof Error ? e.message : "Erreur", ...(code ? { code } : {}) });
    }
  });

  app.post("/api/settings/payments/test-stripe", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const body = z.object({ secretKey: z.string().max(1000).optional() }).safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "Données invalides" });
      const { testStripeConnection } = await import("@/lib/stripe/client.js");
      return await testStripeConnection(body.data.secretKey);
    } catch (e) {
      return reply.code(400).send({
        error: e instanceof Error ? e.message : "Connexion Stripe impossible",
      });
    }
  });

  app.post("/api/settings/payments/sync-catalog", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const { assertStripeEnabled } = await import("@/lib/stripe/client.js");
      await assertStripeEnabled();
      const { syncCatalogFromStripe } = await import("@/lib/stripe/catalog.js");
      const actions = await syncCatalogFromStripe();
      return { ok: true, actions };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 400;
      return reply.code(status).send({
        error: e instanceof Error ? e.message : "Synchronisation impossible",
      });
    }
  });

  app.patch("/api/settings/reminders", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      reminderQuoteDays: z.number().int().min(1).max(90).optional(),
      reminderInvoiceDays: z.number().int().min(1).max(90).optional(),
      nonRenewalNoticeDays: z.number().int().min(1).max(60).optional(),
      reminderDepositMinus7Days: z.number().int().min(1).max(60).optional(),
      reminderDepositMinus1Days: z.number().int().min(1).max(14).optional(),
      reminderDepositPlus3Days: z.number().int().min(1).max(60).optional(),
      reminderDepositPlus10Days: z.number().int().min(1).max(90).optional(),
      reminderDepositMinus7Enabled: z.boolean().optional(),
      reminderDepositMinus1Enabled: z.boolean().optional(),
      reminderDepositPlus3Enabled: z.boolean().optional(),
      reminderDepositPlus10Enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const updated = await saveRemindersTab(parsed.data, actorOf(request));
    return serialize(updated);
  });

  app.patch("/api/settings/identity", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      brandPrimaryColor: hexColor.optional(),
      brandSecondaryColor: hexColor.optional(),
      pdfFooterText: z.string().max(2000).optional().nullable(),
      vatMention: z.string().max(400).optional(),
      latePenaltiesText: z.string().max(500).optional(),
      earlyPaymentDiscountText: z.string().max(300).optional(),
      paymentConditions: z.string().max(300).optional(),
      mediationClause: z.string().trim().max(1000).optional().nullable(),
      cgvPublished: z.boolean().optional(),
      cgvUrl: z.string().trim().url("Adresse web complète attendue (https://…)").max(300).optional().nullable(),
      cgvVersion: z.string().trim().max(40, "40 caractères au plus").optional().nullable(),
      withdrawalExpressRequestText: z.string().trim().min(20, "Texte trop court").max(1000).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const updated = await saveIdentityTab(parsed.data, actorOf(request));
      return serialize(updated);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: e instanceof Error ? e.message : "Erreur" });
    }
  });

  app.post("/api/settings/identity/logo", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "Fichier manquant" });
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      return reply.code(400).send({ error: "Formats acceptés : PNG, JPEG, WebP" });
    }
    const buf = await file.toBuffer();
    if (buf.length > 2 * 1024 * 1024) {
      return reply.code(400).send({ error: "Logo trop volumineux (max 2 Mo)" });
    }
    // Le contenu fait foi, pas le type annoncé par le navigateur.
    const sniffed = sniffLogo(buf);
    if (!sniffed) return reply.code(400).send({ error: "Fichier illisible : envoyez une image PNG, JPEG ou WebP" });
    let stored = buf;
    let ext: "png" | "jpg" = sniffed === "jpeg" ? "jpg" : "png";
    if (sniffed === "webp") {
      // @react-pdf n'imprime que le PNG et le JPEG : un WebP est converti en PNG à l'envoi.
      const { loadSharp } = await import("@/lib/site/media.js");
      const sharp = await loadSharp();
      if (!sharp) return reply.code(400).send({ error: "WebP indisponible sur ce serveur : envoyez un PNG ou un JPEG" });
      try {
        stored = await sharp(buf).png().toBuffer();
      } catch {
        return reply.code(400).send({ error: "Image WebP illisible" });
      }
      ext = "png";
    }
    const dir = uploadsPath("brand");
    await mkdir(dir, { recursive: true });
    const filename = `logo.${ext}`;
    await writeFile(path.join(dir, filename), stored);
    // Ancien logo d'une autre extension : retiré pour ne pas laisser de fichier orphelin.
    await rm(path.join(dir, ext === "png" ? "logo.jpg" : "logo.png"), { force: true });
    const updated = await saveIdentityTab({ brandLogoPath: `brand/${filename}` }, actorOf(request));
    return serialize(updated);
  });

  app.get("/api/settings/identity/logo", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    if (!settings.brandLogoPath) return reply.code(404).send({ error: "Aucun logo" });
    const logo = await readBrandLogo(settings.brandLogoPath);
    if (!logo) return reply.code(404).send({ error: "Fichier logo introuvable" });
    return reply.type(logo.mime).send(logo.buffer);
  });

  // Les PDF déjà émis gardent leur logo : il y est incorporé, pas lié au fichier.
  app.delete("/api/settings/identity/logo", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    if (settings.brandLogoPath) {
      for (const abs of brandLogoCandidates(settings.brandLogoPath)) await rm(abs, { force: true });
    }
    const updated = await saveIdentityTab({ brandLogoPath: null }, actorOf(request));
    return serialize(updated);
  });

  // Aperçu de la charte : rendu réel à partir de données d'exemple, rien n'est enregistré.
  const previewSchema = z.object({
    brandPrimaryColor: hexColor,
    brandSecondaryColor: hexColor,
    pdfFooterText: z.string().max(2000).optional().nullable(),
    logo: z.enum(["current", "none"]).default("current"),
    kind: z.enum(["QUOTE", "INVOICE", "CREDIT_NOTE", "RECEIPT"]).default("INVOICE"),
  });

  app.post("/api/settings/identity/preview.pdf", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { kind, ...draft } = parsed.data;
    const pdf = await renderChartePreviewPdf(kind, draft);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", 'inline; filename="charte-exemple.pdf"')
      .send(pdf);
  });

  app.post("/api/settings/identity/preview", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const [emailHtml, duplicates] = await Promise.all([
      renderChartePreviewEmail(parsed.data),
      footerDuplicates(parsed.data.pdfFooterText),
    ]);
    return { emailHtml, footerDuplicates: duplicates };
  });

  app.patch("/api/settings/declarations", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      urssafPeriodicity: z.nativeEnum(UrssafPeriodicity).optional(),
      treasuryRateBps: z.number().int().min(0).max(5000).optional(),
      placementRateBps: z.number().int().min(0).max(5000).optional(),
      lastIncomeTaxDeclaredYear: z.number().int().min(2000).max(2100).optional().nullable(),
      cfeAmountCents: z.number().int().min(0).optional(),
      cfeAmountEuros: z.coerce.number().min(0).optional(),
      b2cActivity: z.boolean().optional(),
      incomeTaxReminderMonth: z.number().int().min(1).max(12).optional(),
      incomeTaxReminderDay: z.number().int().min(1).max(28).optional(),
      businessStartDate: z.string().optional().nullable(),
      rneRegistrationDate: z.string().optional().nullable(),
      obligationReminderEmail: z.string().email().optional(),
      obligationEmailRemindersEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { cfeAmountEuros, cfeAmountCents, businessStartDate, rneRegistrationDate, ...rest } =
      parsed.data;
    const updated = await saveDeclarationsTab(
      {
        ...rest,
        cfeAmountCents:
          cfeAmountCents ??
          (cfeAmountEuros !== undefined ? Math.round(cfeAmountEuros * 100) : undefined),
        businessStartDate:
          businessStartDate !== undefined
            ? businessStartDate
              ? parseBusinessStartDateInput(businessStartDate)
              : null
            : undefined,
        rneRegistrationDate:
          rneRegistrationDate !== undefined
            ? rneRegistrationDate
              ? parseBusinessStartDateInput(rneRegistrationDate)
              : null
            : undefined,
      },
      actorOf(request),
    );
    if (
      businessStartDate !== undefined ||
      rneRegistrationDate !== undefined ||
      parsed.data.urssafPeriodicity !== undefined
    ) {
      await syncObligationsApresModification();
    }
    return serialize(updated);
  });

  app.get("/api/settings/audit", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { tab?: string; limit?: string };
    const take = Math.min(100, Math.max(1, Number(q.limit) || 40));
    return prisma.settingsAuditLog.findMany({
      where: q.tab ? { tab: q.tab } : undefined,
      orderBy: { createdAt: "desc" },
      take,
    });
  });

  /** Compat : ancien PATCH plat (identité + déclarations). */
  app.patch("/api/settings", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const generalKeys = [
      "legalName",
      "tradeName",
      "siren",
      "siret",
      "apeCode",
      "addressLine1",
      "addressLine2",
      "postalCode",
      "city",
      "country",
      "email",
      "phone",
      "website",
      "publicTrackingShowAmounts",
      "inpiUrl",
    ];
    const general: Record<string, unknown> = {};
    for (const k of generalKeys) {
      if (k in body) general[k] = body[k];
    }
    if (Object.keys(general).length > 0) {
      await saveGeneralTab(general as GeneralPatch, actorOf(request));
    }
    const decl: Record<string, unknown> = {};
    for (const k of [
      "urssafPeriodicity",
      "treasuryRateBps",
      "placementRateBps",
      "lastIncomeTaxDeclaredYear",
      "cfeAmountCents",
      "b2cActivity",
      "incomeTaxReminderMonth",
      "incomeTaxReminderDay",
    ]) {
      if (k in body) decl[k] = body[k];
    }
    if (typeof body.businessStartDate === "string" || body.businessStartDate === null) {
      decl.businessStartDate = body.businessStartDate
        ? parseBusinessStartDateInput(String(body.businessStartDate))
        : null;
    }
    if (typeof body.rneRegistrationDate === "string" || body.rneRegistrationDate === null) {
      decl.rneRegistrationDate = body.rneRegistrationDate
        ? parseBusinessStartDateInput(String(body.rneRegistrationDate))
        : null;
    }
    if (typeof body.cfeAmountEuros === "number") {
      decl.cfeAmountCents = Math.round(body.cfeAmountEuros * 100);
    }
    if (Object.keys(decl).length > 0) {
      await saveDeclarationsTab(decl as DeclarationsPatch, actorOf(request));
      if ("businessStartDate" in decl || "rneRegistrationDate" in decl) {
        await syncObligationsApresModification();
      }
    }
    if (typeof body.bankIban === "string" || body.bankName) {
      await savePaymentsTab(
        {
          bankIban: typeof body.bankIban === "string" ? body.bankIban : undefined,
          bankBic: typeof body.bankBic === "string" ? body.bankBic : undefined,
          bankAccountHolder:
            typeof body.bankAccountHolder === "string" ? body.bankAccountHolder : undefined,
          bankName: typeof body.bankName === "string" ? body.bankName : undefined,
        } as PaymentsPatch,
        actorOf(request),
      );
    }
    invalidateCompanySettingsCache();
    return serialize(await getCompanySettings());
  });

  app.get("/api/settings/smtp", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return getSmtpStatus();
  });

  app.patch("/api/settings/smtp", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      host: z.string().nullable().optional(),
      port: z.number().int().min(1).max(65535).nullable().optional(),
      secure: z.boolean().optional(),
      user: z.string().nullable().optional(),
      pass: z.string().nullable().optional(),
      from: z.string().nullable().optional(),
      keepPassword: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    await saveSmtpSettings({
      host: parsed.data.host ?? null,
      port: parsed.data.port ?? null,
      secure: parsed.data.secure ?? false,
      user: parsed.data.user ?? null,
      pass: parsed.data.pass ?? null,
      from: parsed.data.from ?? null,
      keepPassword: parsed.data.keepPassword,
    });
    return getSmtpStatus();
  });

  app.post("/api/settings/smtp/test", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    const cfg = await resolveSmtpConfig();
    const to = settings.email || cfg?.from;
    if (!to) {
      return reply.code(400).send({ error: "Aucun destinataire (email entreprise ou From SMTP)" });
    }
    try {
      const result = await testSmtpDelivery({ to });
      return { ok: true, to: result.to };
    } catch (e) {
      return reply.code(400).send({ error: formatSmtpError(e) });
    }
  });

  app.post("/api/settings/import-inpi", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      query: z.string().min(3),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Fournissez un SIREN ou une URL data.inpi.fr" });
    }
    try {
      const result = await applyInpiImport(parsed.data.query);
      await syncObligationsApresModification();
      return {
        ...result,
        settings: serialize(result.settings),
      };
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Import INPI impossible" });
    }
  });
};
