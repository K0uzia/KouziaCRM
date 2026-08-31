import nodemailer from "nodemailer";
import { decryptOptional, encryptOptional } from "@/lib/crypto";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company";
import { prisma } from "@/lib/prisma";

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
};

export type SmtpRuntimeConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  source: "db" | "env";
};

function envSmtp(): SmtpRuntimeConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const from = process.env.SMTP_FROM;
  if (!host || !user || !from) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    user,
    pass: process.env.SMTP_PASS || "",
    from,
    source: "env",
  };
}

/** Config SMTP effective : paramètres DB s'ils sont complets, sinon .env. */
export async function resolveSmtpConfig(): Promise<SmtpRuntimeConfig | null> {
  try {
    const s = await getCompanySettings();
    if (s.smtpHost && s.smtpUser && s.smtpFrom) {
      const pass = decryptOptional(s.smtpPassEncrypted) ?? "";
      return {
        host: s.smtpHost,
        port: s.smtpPort ?? 587,
        secure: Boolean(s.smtpSecure),
        user: s.smtpUser,
        pass,
        from: s.smtpFrom,
        source: "db",
      };
    }
  } catch {
    // CompanySettings peut manquer au boot / seed
  }
  return envSmtp();
}

export async function isSmtpConfigured(): Promise<boolean> {
  const cfg = await resolveSmtpConfig();
  return Boolean(cfg?.host && cfg.user && cfg.from);
}

/** Compat sync pour les appels historiques (préférer isSmtpConfigured async). */
export function isSmtpConfiguredSync(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_FROM);
}

export async function getSmtpStatus() {
  const cfg = await resolveSmtpConfig();
  if (!cfg) {
    return {
      configured: false,
      source: null as "db" | "env" | null,
      host: null as string | null,
      port: null as number | null,
      secure: false,
      user: null as string | null,
      from: null as string | null,
      hasPassword: false,
    };
  }
  return {
    configured: true,
    source: cfg.source,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    from: cfg.from,
    hasPassword: Boolean(cfg.pass),
  };
}

export async function saveSmtpSettings(input: {
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string | null;
  /** Si true, ne pas écraser le mot de passe déjà stocké. */
  keepPassword?: boolean;
}) {
  const current = await getCompanySettings();
  let smtpPassEncrypted = current.smtpPassEncrypted;
  if (input.pass !== null && input.pass !== undefined && input.pass !== "") {
    smtpPassEncrypted = encryptOptional(input.pass);
  } else if (!input.keepPassword && input.pass === "") {
    smtpPassEncrypted = null;
  }

  const updated = await prisma.companySettings.update({
    where: { id: current.id },
    data: {
      smtpHost: input.host || null,
      smtpPort: input.port,
      smtpSecure: input.secure,
      smtpUser: input.user || null,
      smtpPassEncrypted,
      smtpFrom: input.from || null,
    },
  });
  invalidateCompanySettingsCache();
  return updated;
}

export async function createSmtpTransport() {
  const cfg = await resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP non configuré");
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

export async function sendEmail(input: SendEmailInput) {
  const cfg = await resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP non configuré");
  const transport = await createSmtpTransport();
  const info = await transport.sendMail({
    from: cfg.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
    headers: input.headers,
    attachments: input.attachments,
  });
  return {
    messageId: info.messageId,
    accepted: info.accepted,
  };
}
