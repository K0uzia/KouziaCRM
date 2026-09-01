import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UrssafPeriodicity } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { parseBusinessStartDateInput, formatBusinessStartDateForApi } from "@/lib/company/business-start.js";
import { applyInpiImport } from "@/lib/company/inpi.js";
import { syncObligations } from "@/lib/obligations/obligation-service.js";
import {
  isSmtpConfigured,
  testSmtpDelivery,
  formatSmtpError,
  getSmtpStatus,
  saveSmtpSettings,
  resolveSmtpConfig,
} from "@/lib/email/smtp.js";
import { testImapConnection } from "@/lib/email/imap-config.js";
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

const optionalEmail = z.string().email().optional().nullable().or(z.literal(""));
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

function brandUploadsDir(): string {
  return path.resolve(process.cwd(), "data", "uploads", "brand");
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
      legalName: z.string().min(1).optional(),
      tradeName: z.string().optional().nullable(),
      siren: z.string().regex(/^\d{9}$/).optional(),
      siret: z.string().regex(/^\d{14}$/).optional(),
      apeCode: z.string().min(1).optional(),
      addressLine1: z.string().min(1).optional(),
      addressLine2: z.string().optional().nullable(),
      postalCode: z.string().min(1).optional(),
      city: z.string().min(1).optional(),
      country: z.string().optional(),
      email: optionalEmail,
      phone: z.string().optional().nullable(),
      website: z.string().optional().nullable(),
      legalForm: z.string().max(80).optional().nullable(),
      rcsMention: z.string().max(200).optional().nullable(),
      vatIntraNumber: z.string().max(20).optional().nullable(),
      decennaleInsurer: z.string().max(200).optional().nullable(),
      decennalePolicyNumber: z.string().max(80).optional().nullable(),
      decennaleCoverageZone: z.string().max(200).optional().nullable(),
      publicTrackingShowAmounts: z.boolean().optional(),
      clientPortalUrl: z.string().url().optional().nullable().or(z.literal("")),
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
      emailThrottlePerMinute: z.number().int().min(1).max(120).optional(),
      imapHost: z.string().optional().nullable(),
      imapPort: z.number().int().min(1).max(65535).optional().nullable(),
      imapSecure: z.boolean().optional(),
      imapUser: z.string().optional().nullable(),
      imapPass: z.string().optional().nullable(),
      imapMailbox: z.string().optional().nullable(),
      imapPollIntervalMinutes: z.number().int().min(5).max(120).optional(),
      attachmentMaxFileMb: z.number().int().min(1).max(200).optional(),
      attachmentMaxMessageMb: z.number().int().min(1).max(500).optional(),
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
      revolutMerchantApiKey: z.string().optional().nullable(),
      revolutWebhookSecret: z.string().optional().nullable(),
      revolutMerchantMode: z.enum(["sandbox", "production"]).optional(),
      depositCount: z.number().int().min(2).max(2).optional(),
      depositPercent1Bps: z.number().int().min(0).max(10000).optional(),
      depositPercent2Bps: z.number().int().min(0).max(10000).optional(),
      depositPercent3Bps: z.number().int().min(0).max(10000).optional(),
      paymentButtonLeadDays: z.number().int().min(0).max(30).optional(),
      projectMilestoneMidBps: z.number().int().min(1000).max(9000).optional(),
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
      return reply.code(status).send({ error: e instanceof Error ? e.message : "Erreur" });
    }
  });

  app.post("/api/settings/payments/test-revolut", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    const key = decryptOptional(settings.revolutMerchantApiKeyEncrypted);
    if (!key) {
      return reply.code(400).send({ error: "Clé API Merchant absente. Enregistrez-la puis retestez." });
    }
    const mode = settings.revolutMerchantMode === "production" ? "production" : "sandbox";
    const base =
      mode === "production"
        ? "https://merchant.revolut.com"
        : "https://sandbox-merchant.revolut.com";
    try {
      const res = await fetch(`${base}/api/orders?limit=1`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Revolut-Api-Version": "2024-09-01",
          Accept: "application/json",
        },
      });
      if (res.status === 401 || res.status === 403) {
        return reply.code(400).send({
          error: `Revolut a refusé la clé (${res.status}). Vérifiez le mode ${mode} et la clé secrète Merchant.`,
        });
      }
      if (!res.ok && res.status >= 500) {
        return reply.code(400).send({ error: `Revolut indisponible (${res.status})` });
      }
      return { ok: true, mode, status: res.status };
    } catch (e) {
      return reply.code(400).send({
        error: e instanceof Error ? e.message : "Connexion Revolut impossible",
      });
    }
  });

  app.patch("/api/settings/reminders", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      reminderQuoteDays: z.number().int().min(1).max(90).optional(),
      reminderInvoiceDays: z.number().int().min(1).max(90).optional(),
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
    const ext = file.mimetype === "image/png" ? "png" : file.mimetype === "image/webp" ? "webp" : "jpg";
    const dir = brandUploadsDir();
    await mkdir(dir, { recursive: true });
    const filename = `logo.${ext}`;
    await writeFile(path.join(dir, filename), buf);
    const rel = path.join("brand", filename);
    const updated = await saveIdentityTab({ brandLogoPath: rel }, actorOf(request));
    return serialize(updated);
  });

  app.get("/api/settings/identity/logo", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    if (!settings.brandLogoPath) return reply.code(404).send({ error: "Aucun logo" });
    const abs = path.resolve(process.cwd(), "data", "uploads", settings.brandLogoPath);
    try {
      const buf = await readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const ctype =
        ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      return reply.type(ctype).send(buf);
    } catch {
      return reply.code(404).send({ error: "Fichier logo introuvable" });
    }
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
    if (businessStartDate !== undefined || rneRegistrationDate !== undefined) {
      await syncObligations();
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
        await syncObligations();
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
      await syncObligations();
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
