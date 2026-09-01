import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { Transporter } from "nodemailer";
import { decryptOptional } from "@/lib/crypto";
import { getCompanySettings } from "@/lib/company";
import { formatFrom } from "@/lib/email/mailer/headers.js";
import {
  defaultPortForEncryption,
  inferSmtpEncryptionFromEnv,
  resolveSmtpEncryption,
  smtpRequiresAuth,
  type SmtpEncryption,
} from "@/lib/settings/defaults.js";
import { saveEmailTab } from "@/lib/settings/service.js";

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
  encryption: SmtpEncryption;
  user: string;
  pass: string;
  from: string;
  source: "db" | "env" | "draft";
};

export type SmtpTestOverride = {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpEncryption?: SmtpEncryption | null;
  smtpUser?: string | null;
  smtpPass?: string | null;
  smtpFrom?: string | null;
};

function envSmtp(): SmtpRuntimeConfig | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const encryption = inferSmtpEncryptionFromEnv({
    host,
    port,
    secure: process.env.SMTP_SECURE,
  });
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";
  if (smtpRequiresAuth(encryption) && !user) return null;
  return {
    host,
    port,
    secure: encryption === "SSL",
    encryption,
    user,
    pass,
    from,
    source: "env",
  };
}

function buildRuntimeConfig(opts: {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  user: string;
  pass: string;
  from: string;
  source: SmtpRuntimeConfig["source"];
}): SmtpRuntimeConfig {
  return {
    host: opts.host,
    port: opts.port,
    encryption: opts.encryption,
    secure: opts.encryption === "SSL",
    user: opts.user,
    pass: opts.pass,
    from: opts.from,
    source: opts.source,
  };
}

/** Config SMTP effective : paramètres DB s'ils sont complets, sinon .env. */
export async function resolveSmtpConfig(): Promise<SmtpRuntimeConfig | null> {
  try {
    const s = await getCompanySettings();
    if (s.smtpHost && s.smtpFrom) {
      const encryption = resolveSmtpEncryption(s);
      const pass = decryptOptional(s.smtpPassEncrypted) ?? "";
      const user = s.smtpUser?.trim() ?? "";
      const authOk = !smtpRequiresAuth(encryption) || (Boolean(user) && Boolean(pass));
      if (authOk) {
        return buildRuntimeConfig({
          host: s.smtpHost,
          port: s.smtpPort ?? defaultPortForEncryption(encryption),
          encryption,
          user,
          pass,
          from: s.smtpFrom,
          source: "db",
        });
      }
    }
  } catch {
    // CompanySettings peut manquer au boot / seed
  }
  return envSmtp();
}

/** Fusionne un brouillon (formulaire) avec la config enregistrée pour un test à blanc. */
export async function resolveSmtpConfigForTest(
  draft?: SmtpTestOverride | null,
): Promise<SmtpRuntimeConfig | null> {
  const base = await resolveSmtpConfig();
  if (!draft) return base;

  const settings = await getCompanySettings().catch(() => null);
  const encryption =
    draft.smtpEncryption ??
    (settings ? resolveSmtpEncryption(settings) : base?.encryption ?? "SSL");

  const host =
    draft.smtpHost?.trim() ||
    base?.host ||
    settings?.smtpHost ||
    "";
  const user =
    draft.smtpUser?.trim() ||
    base?.user ||
    settings?.smtpUser ||
    "";
  const from =
    draft.smtpFrom?.trim() ||
    base?.from ||
    settings?.smtpFrom ||
    "";

  if (!host || !from) return null;
  if (smtpRequiresAuth(encryption) && !user) return null;

  let pass = "";
  if (draft.smtpPass !== undefined && draft.smtpPass !== null && draft.smtpPass !== "") {
    pass = draft.smtpPass;
  } else if (base?.pass) {
    pass = base.pass;
  } else if (settings?.smtpPassEncrypted) {
    pass = decryptOptional(settings.smtpPassEncrypted) ?? "";
  }

  const port =
    draft.smtpPort ??
    base?.port ??
    settings?.smtpPort ??
    defaultPortForEncryption(encryption);

  return buildRuntimeConfig({
    host,
    port,
    encryption,
    user,
    pass,
    from,
    source: draft.smtpHost || draft.smtpUser || draft.smtpPass ? "draft" : base?.source ?? "db",
  });
}

export async function isSmtpConfigured(): Promise<boolean> {
  const cfg = await resolveSmtpConfig();
  if (!cfg?.host || !cfg.from) return false;
  if (!smtpRequiresAuth(cfg.encryption)) return true;
  return Boolean(cfg.user && cfg.pass);
}

/** Compat sync pour les appels historiques (préférer isSmtpConfigured async). */
export function isSmtpConfiguredSync(): boolean {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) return false;
  const encryption = inferSmtpEncryptionFromEnv({
    host,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    secure: process.env.SMTP_SECURE,
  });
  if (!smtpRequiresAuth(encryption)) return true;
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
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
    configured: smtpRequiresAuth(cfg.encryption) ? Boolean(cfg.pass && cfg.user) : true,
    source: cfg.source === "draft" ? "db" : cfg.source,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user || null,
    from: cfg.from,
    hasPassword: Boolean(cfg.pass),
  };
}

export function formatSmtpError(error: unknown): string {
  const err = error as {
    code?: string;
    responseCode?: number;
    response?: string;
    message?: string;
  };
  if (err.code === "EAUTH" || err.responseCode === 535) {
    return (
      "Authentification refusée par Hostinger. Utilisez l'adresse complète (contact@kouzia.com) " +
      "et le mot de passe de la boîte mail (hPanel > Emails > Boîtes mail), pas le mot de passe hPanel. " +
      "Si la 2FA est activée sur la boîte, créez un mot de passe d'application."
    );
  }
  if (err.code === "ESOCKET" || err.code === "ETIMEDOUT" || err.code === "ECONNECTION") {
    return `Connexion SMTP impossible (${err.code ?? "réseau"}) : vérifiez l'hôte, le port et le pare-feu.`;
  }
  if (err.code === "ECONNREFUSED") {
    const portHint =
      err.message?.includes("1025") || err.message?.includes("127.0.0.1")
        ? " Mailpit injoignable sur 127.0.0.1:1025 : lancez `make mailpit` et vérifiez le chiffrement « Aucun » (NONE)."
        : " Vérifiez l'hôte, le port (465 SSL ou 587 STARTTLS) et que le serveur SMTP écoute.";
    return `Connexion refusée.${portHint}`;
  }
  return err.message ?? "Échec de l'envoi SMTP";
}

export function createTransportFromConfig(cfg: SmtpRuntimeConfig, pool = false) {
  const options: SMTPTransport.Options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    pool,
  };
  if (cfg.user) {
    options.auth = { user: cfg.user, pass: cfg.pass };
  }
  if (
    cfg.encryption === "STARTTLS" &&
    cfg.port !== 1025 &&
    cfg.encryption !== "NONE"
  ) {
    options.requireTLS = true;
  }
  return nodemailer.createTransport(options);
}

let sharedTransport: Transporter | null = null;
let sharedTransportKey: string | null = null;

export async function resolveFromAddress(fromName?: string | null): Promise<string> {
  const cfg = await resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP non configuré");
  let name = fromName;
  if (name === undefined) {
    try {
      const s = await getCompanySettings();
      name = s.smtpFromName;
    } catch {
      name = null;
    }
  }
  return formatFrom(cfg.from, name);
}

export async function getSharedTransport(): Promise<Transporter> {
  const cfg = await resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP non configuré");
  if (smtpRequiresAuth(cfg.encryption) && !cfg.pass) {
    throw new Error("Mot de passe SMTP manquant dans les Paramètres");
  }
  const key = `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.encryption}`;
  if (sharedTransport && sharedTransportKey === key) return sharedTransport;
  if (sharedTransport) {
    sharedTransport.close();
    sharedTransport = null;
  }
  sharedTransport = createTransportFromConfig(cfg, true);
  sharedTransportKey = key;
  return sharedTransport;
}

export async function verifySmtpConnection(cfg: SmtpRuntimeConfig): Promise<void> {
  if (smtpRequiresAuth(cfg.encryption) && !cfg.pass) {
    throw Object.assign(new Error("Mot de passe SMTP manquant : saisissez-le puis Enregistrer, ou retestez après l'avoir collé dans le champ."), {
      code: "ENOAUTH",
    });
  }
  const transport = createTransportFromConfig(cfg);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export type SmtpTestResult = {
  ok: true;
  to: string;
  source: SmtpRuntimeConfig["source"];
  host: string;
  port: number;
  encryption: SmtpEncryption;
};

export async function testSmtpDelivery(opts: {
  to: string;
  draft?: SmtpTestOverride | null;
}): Promise<SmtpTestResult> {
  const cfg = await resolveSmtpConfigForTest(opts.draft);
  if (!cfg) {
    throw Object.assign(new Error("SMTP incomplet : hôte, utilisateur et expéditeur requis"), {
      code: "ECONFIG",
    });
  }

  await verifySmtpConnection(cfg);

  const transport = createTransportFromConfig(cfg);
  try {
    await transport.sendMail({
      from: cfg.from,
      to: opts.to,
      subject: "Test SMTP Kouzia",
      text: "Cet email confirme que la configuration SMTP fonctionne.",
    });
  } finally {
    transport.close();
  }

  return {
    ok: true,
    to: opts.to,
    source: cfg.source,
    host: cfg.host,
    port: cfg.port,
    encryption: cfg.encryption,
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
  return saveEmailTab({
    smtpHost: input.host,
    smtpPort: input.port,
    smtpEncryption: input.secure ? "SSL" : "STARTTLS",
    smtpUser: input.user,
    smtpPass: input.keepPassword ? undefined : input.pass,
    smtpFrom: input.from,
  });
}

export async function createSmtpTransport() {
  const cfg = await resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP non configuré");
  if (smtpRequiresAuth(cfg.encryption) && !cfg.pass) {
    throw new Error("Mot de passe SMTP manquant dans les Paramètres");
  }
  return createTransportFromConfig(cfg);
}

export async function sendEmail(input: SendEmailInput) {
  const cfg = await resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP non configuré");
  if (smtpRequiresAuth(cfg.encryption) && !cfg.pass) {
    throw new Error("Mot de passe SMTP manquant dans les Paramètres");
  }
  let replyTo = input.replyTo;
  try {
    const s = await getCompanySettings();
    if (!replyTo && s.smtpReplyTo) replyTo = s.smtpReplyTo;
  } catch {
    /* ignore */
  }
  const from = await resolveFromAddress();
  const transport = await getSharedTransport();
  const info = await transport.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    replyTo,
    headers: input.headers,
    attachments: input.attachments,
  });
  return {
    messageId: info.messageId,
    accepted: info.accepted,
  };
}
