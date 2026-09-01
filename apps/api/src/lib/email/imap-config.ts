import { ImapFlow } from "imapflow";
import { decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";

export type ImapRuntimeConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  source: "db" | "env" | "draft";
};

export type ImapTestOverride = {
  imapHost?: string | null;
  imapPort?: number | null;
  imapSecure?: boolean | null;
  imapUser?: string | null;
  imapPass?: string | null;
  imapMailbox?: string | null;
};

function envImap(): ImapRuntimeConfig | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== "false",
    user,
    pass,
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
    source: "env",
  };
}

export async function resolveImapConfig(): Promise<ImapRuntimeConfig | null> {
  try {
    const s = await getCompanySettings();
    if (s.imapHost && s.imapUser) {
      const pass = decryptOptional(s.imapPassEncrypted) ?? "";
      return {
        host: s.imapHost,
        port: s.imapPort ?? 993,
        secure: s.imapSecure !== false,
        user: s.imapUser,
        pass,
        mailbox: s.imapMailbox || "INBOX",
        source: "db",
      };
    }
  } catch {
    // seed / boot
  }
  return envImap();
}

/** Fusionne un brouillon (formulaire) avec la config enregistrée pour un test à blanc. */
export async function resolveImapConfigForTest(
  draft?: ImapTestOverride | null,
): Promise<ImapRuntimeConfig | null> {
  const base = await resolveImapConfig();
  if (!draft) return base;

  const settings = await getCompanySettings().catch(() => null);

  const host =
    draft.imapHost?.trim() ||
    base?.host ||
    settings?.imapHost ||
    "";
  const user =
    draft.imapUser?.trim() ||
    base?.user ||
    settings?.imapUser ||
    "";

  if (!host || !user) return null;

  let pass = "";
  if (draft.imapPass !== undefined && draft.imapPass !== null && draft.imapPass !== "") {
    pass = draft.imapPass;
  } else if (base?.pass) {
    pass = base.pass;
  } else if (settings?.imapPassEncrypted) {
    pass = decryptOptional(settings.imapPassEncrypted) ?? "";
  }

  const port =
    draft.imapPort ??
    base?.port ??
    settings?.imapPort ??
    993;

  const secure =
    draft.imapSecure ??
    base?.secure ??
    settings?.imapSecure ??
    true;

  const mailbox =
    draft.imapMailbox?.trim() ||
    base?.mailbox ||
    settings?.imapMailbox ||
    "INBOX";

  const usesDraftFields = Boolean(
    draft.imapHost || draft.imapUser || draft.imapPass || draft.imapPort != null,
  );

  return {
    host,
    port,
    secure,
    user,
    pass,
    mailbox,
    source: usesDraftFields ? "draft" : base?.source ?? "db",
  };
}

export async function isImapConfigured(): Promise<boolean> {
  const cfg = await resolveImapConfig();
  return Boolean(cfg?.host && cfg.user && cfg.pass);
}

export function formatImapError(error: unknown): string {
  const err = error as {
    authenticationFailed?: boolean;
    responseText?: string;
    responseStatus?: string;
    code?: string;
    message?: string;
  };
  const message = (err.message ?? "").toLowerCase();
  const response = (err.responseText ?? "").toLowerCase();
  if (
    err.authenticationFailed ||
    err.code === "EAUTH" ||
    message.includes("authentication failed") ||
    message.includes("invalid credentials") ||
    response.includes("authentication failed")
  ) {
    return (
      "Authentification IMAP refusée. Utilisez l'adresse complète (contact@kouzia.com) " +
      "et le mot de passe de la boîte mail (hPanel > Emails > Boîtes mail), pas le mot de passe hPanel."
    );
  }
  if (err.code === "ECONNREFUSED") {
    return "Connexion IMAP refusée : vérifiez l'hôte, le port (993 SSL) et le pare-feu.";
  }
  if (err.code === "ETIMEDOUT" || err.code === "ESOCKET" || err.code === "ECONNECTION") {
    return `Connexion IMAP impossible (${err.code ?? "réseau"}) : vérifiez l'hôte et le port.`;
  }
  if (
    message.includes("invalid messageset") ||
    response.includes("invalid messageset")
  ) {
    return "Plage de messages IMAP invalide (dossier vide ou déjà à jour).";
  }
  return err.message ?? "Connexion IMAP impossible";
}

export type ImapTestResult =
  | { ok: true; mailbox: string; source: ImapRuntimeConfig["source"] }
  | { ok: false; error: string };

export async function testImapConnection(opts?: {
  draft?: ImapTestOverride | null;
}): Promise<ImapTestResult> {
  const cfg = await resolveImapConfigForTest(opts?.draft);
  if (!cfg) {
    return { ok: false, error: "IMAP non configuré (hôte et utilisateur requis)" };
  }
  if (!cfg.pass) {
    return {
      ok: false,
      error:
        "Mot de passe IMAP manquant : saisissez-le dans le formulaire ou Enregistrez-le avant de tester.",
    };
  }
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  try {
    await client.connect();
    await client.mailboxOpen(cfg.mailbox);
    return { ok: true, mailbox: cfg.mailbox, source: cfg.source };
  } catch (e) {
    return { ok: false, error: formatImapError(e) };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
