import type { Client } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue, sendOutboxImmediately } from "@/lib/email/mailer/index.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { decryptOptional } from "@/lib/crypto.js";
import { prisma } from "@/lib/prisma.js";
import { CODE_TTL_MS, maskEmail } from "@/lib/portal/auth.js";
import { formatDateTimeLongFr } from "@/lib/format-fr.js";
import type { ReviewOptions } from "@/lib/email/review.js";
import { templateText } from "@/lib/email/template-registry.js";

/**
 * E-mails de l'espace client. Connexion par e-mail + code à usage unique :
 * aucun identifiant permanent n'est jamais envoyé.
 */

export type SendAccessEmailResult = {
  sent: boolean;
  reason?: "smtp_off" | "no_email" | "error";
};

/** Kinds exclus de l'historique « e-mails reçus » du portail (codes éphémères, alertes). */
export const PORTAL_CODE_KINDS = ["portal_code", "portal_alert"];

const fmtDateTime = (d: Date) => formatDateTimeLongFr(d);

function greeting(client: Pick<Client, "firstName" | "displayName">): string {
  const first = client.firstName?.trim() || client.displayName.trim().split(/\s+/)[0];
  return first ? `Bonjour ${first},` : "Bonjour,";
}

async function signatureBlock(): Promise<{ brand: string; signature: string }> {
  const company = await getCompanySettings();
  return {
    brand: company.tradeName ?? company.legalName,
    signature: formatPlainTextSignature(company, await brandFromSettings()),
  };
}

/**
 * Message urgent (code) : envoyé tout de suite, le worker reprend en cas d'échec.
 * Sans SMTP hors production, le code est écrit dans la console pour pouvoir tester.
 */
async function sendNow(opts: {
  client: Client;
  subject: string;
  text: string;
  kind: string;
  devCode?: string;
}): Promise<void> {
  const email = decryptOptional(opts.client.emailEncrypted);
  if (!email) return;
  if (!(await isSmtpConfigured())) {
    if (process.env.NODE_ENV !== "production" && opts.devCode) {
      console.info(`[portail] SMTP non configuré, code pour ${maskEmail(email)} : ${opts.devCode}`);
    }
    return;
  }
  const { outboxId } = await mailEnqueue({
    to: email,
    subject: opts.subject,
    text: opts.text,
    clientId: opts.client.id,
    kind: opts.kind,
  });
  await sendOutboxImmediately(outboxId);
}

const minutes = Math.round(CODE_TTL_MS / 60_000);

export async function sendLoginCodeEmail(client: Client, code: string): Promise<void> {
  const { brand, signature } = await signatureBlock();
  const text = [
    greeting(client),
    "",
    `Voici votre code de connexion à votre espace client ${brand} :`,
    "",
    code,
    "",
    `Il est valable ${minutes} minutes et ne sert qu'une fois. Une fois connecté, cet appareil est reconnu pendant 7 jours.`,
    "",
    "Vous n'avez rien demandé ? Ignorez cet e-mail : sans ce code, personne ne peut entrer dans votre espace.",
    "",
    signature,
  ].join("\n");
  await sendNow({
    client,
    subject: `${code} : votre code de connexion ${brand}`,
    text,
    kind: "portal_code",
    devCode: code,
  });
}

export async function sendSignCodeEmail(
  client: Client,
  code: string,
  quoteNumber: string | null,
): Promise<void> {
  const { brand, signature } = await signatureBlock();
  const devis = quoteNumber ? `le devis ${quoteNumber}` : "votre devis";
  const text = [
    greeting(client),
    "",
    `Voici le code qui confirme votre signature pour ${devis} :`,
    "",
    code,
    "",
    `Il est valable ${minutes} minutes et ne sert qu'une fois.`,
    "",
    "Vous n'êtes pas en train de signer ce devis ? Ne communiquez ce code à personne et prévenez-moi en répondant à cet e-mail.",
    "",
    signature,
  ].join("\n");
  await sendNow({
    client,
    subject: `${code} : code de signature ${brand}`,
    text,
    kind: "portal_code",
    devCode: code,
  });
}

export async function sendNewDeviceAlertEmail(
  client: Client,
  opts: { device: string; at: Date },
): Promise<void> {
  const { brand, signature } = await signatureBlock();
  const text = [
    greeting(client),
    "",
    `Une connexion à votre espace client ${brand} vient d'avoir lieu depuis un nouvel appareil :`,
    "",
    `${opts.device}, le ${fmtDateTime(opts.at)}.`,
    "",
    "C'est vous ? Il n'y a rien à faire.",
    "Ce n'est pas vous ? Répondez à cet e-mail : je déconnecte tous les appareils et nous vérifions ensemble l'accès à votre messagerie.",
    "",
    signature,
  ].join("\n");
  await sendNow({
    client,
    subject: `Nouvelle connexion à votre espace client ${brand}`,
    text,
    kind: "portal_alert",
  });
}

/** E-mail d'accès à l'espace client tel que l'ERP l'enverrait (« Vérifier l'e-mail ») ; null sans adresse. */
export async function portalWelcomeDraft(clientId: string): Promise<{ to: string; subject: string; text: string; attachments: string[] } | null> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const email = decryptOptional(client?.emailEncrypted ?? null);
  if (!client || !email) return null;
  const { brand, signature } = await signatureBlock();
  const portalUrl = await resolveClientPortalUrl();
  const howTo = `Saisissez votre adresse e-mail (${email}) : vous recevez aussitôt un code à 6 chiffres. Aucun mot de passe à retenir.`;
  // Modèle modifié dans Réglages (M3c) : le lien et la façon de se connecter restent des blocs fixes.
  const content = await templateText(
    "access.welcome",
    { salutation: greeting(client), marque: brand, lien: portalUrl, bloc_connexion: howTo },
    {
      subject: `Votre espace client ${brand}`,
      body: [
        greeting(client),
        "",
        "Votre espace client est prêt. Vous y retrouvez vos devis, factures et paiements, et l'avancement de votre projet.",
        "",
        `Pour y entrer : ${portalUrl}`,
        howTo,
      ].join("\n"),
    },
  );
  return { to: email, subject: content.subject, text: [content.body, "", signature].join("\n"), attachments: [] };
}

/**
 * Après l'onboarding : explique comment entrer dans l'espace client (e-mail + code). edits : objet et texte relus.
 * review : envoi automatique (fiche remplie par le prospect), relu dans « E-mails à valider » comme les autres.
 */
export async function sendPortalWelcomeEmail(
  clientId: string,
  edits: { subject?: string; text?: string } = {},
  review?: ReviewOptions,
): Promise<SendAccessEmailResult> {
  if (!(await isSmtpConfigured())) return { sent: false, reason: "smtp_off" };
  const draft = await portalWelcomeDraft(clientId);
  if (!draft) return { sent: false, reason: "no_email" };

  try {
    const body = edits.text?.trim() || draft.text;
    await mailEnqueue({
      to: draft.to,
      subject: edits.subject?.trim() || draft.subject,
      text: body,
      clientId,
      kind: "access",
      markAccessEmailSent: true,
      bodyTextForMessage: body,
    }, review ? { review } : undefined);
    return { sent: true };
  } catch (err) {
    console.error(`[email] e-mail d'accès à l'espace client échoué pour ${clientId}`, err);
    return { sent: false, reason: "error" };
  }
}
