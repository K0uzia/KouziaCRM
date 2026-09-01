/** Valeurs Hostinger (hPanel) : pré-remplissage prod. */
export const HOSTINGER_MAIL_DEFAULTS = {
  smtpHost: "smtp.hostinger.com",
  smtpPort: 465,
  smtpEncryption: "SSL" as const,
  smtpUser: "contact@kouzia.com",
  smtpFromName: "KOUZIA",
  smtpFrom: "KOUZIA <contact@kouzia.com>",
  smtpReplyTo: "contact@kouzia.com",
  imapHost: "imap.hostinger.com",
  imapPort: 993,
  imapSecure: true,
  imapUser: "contact@kouzia.com",
  imapMailbox: "INBOX",
};

/** Valeurs Mailpit : pré-remplissage dev local (`make mailpit`). */
export const MAILPIT_MAIL_DEFAULTS = {
  smtpHost: "127.0.0.1",
  smtpPort: 1025,
  smtpEncryption: "NONE" as const,
  smtpUser: "",
  smtpFromName: "Kouzia",
  smtpFrom: "Kouzia <dev@localhost>",
  smtpReplyTo: "dev@localhost",
  imapHost: "",
  imapPort: 993,
  imapSecure: true,
  imapUser: "",
  imapMailbox: "INBOX",
};

/** Plafonds pièces jointes : 2-3 PDF + photos + une video courte compressée. */
export const ATTACHMENT_DEFAULTS = {
  maxFileMb: 50,
  maxMessageMb: 80,
  maxFileMbCap: 200,
  maxMessageMbCap: 500,
};

export const BRAND_COLOR_DEFAULTS = {
  primary: "#0f766e",
  secondary: "#0f172a",
};

export type SmtpEncryption = "SSL" | "STARTTLS" | "NONE";

export function isSmtpEncryption(value: string | null | undefined): value is SmtpEncryption {
  return value === "SSL" || value === "STARTTLS" || value === "NONE";
}

export function encryptionFromLegacySecure(secure: boolean): SmtpEncryption {
  return secure ? "SSL" : "STARTTLS";
}

export function resolveSmtpEncryption(opts: {
  smtpEncryption?: string | null;
  smtpSecure?: boolean;
}): SmtpEncryption {
  if (isSmtpEncryption(opts.smtpEncryption)) return opts.smtpEncryption;
  return encryptionFromLegacySecure(Boolean(opts.smtpSecure));
}

export function smtpSecureFromEncryption(encryption: SmtpEncryption): boolean {
  return encryption === "SSL";
}

export function defaultPortForEncryption(encryption: SmtpEncryption): number {
  if (encryption === "SSL") return 465;
  if (encryption === "STARTTLS") return 587;
  return 1025;
}

/** Infère le chiffrement SMTP depuis l'hôte/port (Mailpit local = NONE). */
export function inferSmtpEncryptionFromEnv(opts: {
  host?: string | null;
  port?: number | null;
  secure?: boolean | string | null;
}): SmtpEncryption {
  const port = opts.port != null ? Number(opts.port) : undefined;
  const host = (opts.host ?? "").trim().toLowerCase();
  const secure = opts.secure === true || opts.secure === "true";
  if (port === 1025) return "NONE";
  if ((host === "127.0.0.1" || host === "localhost") && !secure) return "NONE";
  if (secure) return "SSL";
  return "STARTTLS";
}

export function smtpRequiresAuth(encryption: SmtpEncryption): boolean {
  return encryption !== "NONE";
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}
