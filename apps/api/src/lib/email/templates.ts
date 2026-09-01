import { getCompanySettings } from "@/lib/company";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";

export type EmailTemplateKind =
  | "quote"
  | "invoice"
  | "invoice_acompte"
  | "invoice_solde"
  | "credit_note"
  | "reminder_soft"
  | "reminder_firm"
  | "reminder_formal"
  | "access"
  | "onboarding"
  | "payment_received";

export type EmailBrand = {
  tradeName: string;
  legalName: string;
  siret: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  addressLine1: string;
  postalCode: string;
  city: string;
};

export type EmailContentInput = {
  kind: EmailTemplateKind;
  clientFirstName?: string | null;
  clientName: string;
  docNumber?: string | null;
  docLabel?: string | null;
  projectLabel?: string | null;
  brand: EmailBrand;
  extraLines?: string[];
  /** URL portail client (sinon résolue automatiquement). */
  clientPortalUrl?: string | null;
  /** Lien Revolut : déclenche le bouton HTML minimal. */
  paymentUrl?: string | null;
  brandPrimaryColor?: string;
  /** Montant payé (centimes) pour payment_received. */
  paidAmountCents?: number;
};

function greeting(name?: string | null): string {
  const n = name?.trim();
  return n ? `Bonjour ${n},` : "Bonjour,";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bouton HTML minimal pour les emails de paiement (seule exception HTML autorisée). */
export function renderPaymentButtonHtml(opts: {
  url: string;
  label?: string;
  brandPrimaryColor: string;
}): string {
  const color = opts.brandPrimaryColor || "#0f766e";
  const label = escapeHtml(opts.label ?? "Payer en ligne");
  const url = escapeHtml(opts.url);
  return `<p><a href="${url}" style="display:inline-block;padding:12px 20px;background:${color};color:#ffffff;text-decoration:none;border-radius:6px;font-family:sans-serif;font-size:15px;">${label}</a></p>
<p style="font-size:12px;color:#64748b;font-family:sans-serif;">Ou copiez ce lien : ${url}</p>`;
}

export function quoteTrackingBlockText(portalUrl: string): string {
  return [
    `Vous pouvez retrouver ce devis et l'ensemble de vos documents sur votre espace de suivi : ${portalUrl}`,
    "Vous pouvez valider ce devis directement depuis cette page, ou simplement répondre à cet email pour confirmer - nous nous chargeons alors de la validation et de l'envoi de votre demande d'acompte.",
  ].join("\n");
}

export function invoiceTrackingBlockText(portalUrl: string): string {
  return `Vous pouvez retrouver cette facture et l'ensemble de vos documents sur votre espace de suivi : ${portalUrl}`;
}

function paymentLinesText(paymentUrl: string): string[] {
  return ["", "Régler en ligne :", paymentUrl];
}

function subjectFor(input: EmailContentInput): string {
  const num = input.docNumber?.trim();
  const project = input.projectLabel?.trim();
  switch (input.kind) {
    case "quote":
      return num
        ? `Devis ${num}${project ? ` : ${project}` : ""}`
        : "Votre devis";
    case "invoice_acompte":
      return num ? `Facture d'acompte ${num}` : "Facture d'acompte";
    case "invoice_solde":
      return num ? `Facture de solde ${num}` : "Facture de solde";
    case "invoice":
      return num ? `Facture ${num}${project ? ` : ${project}` : ""}` : "Votre facture";
    case "credit_note":
      return num ? `Avoir ${num}` : "Votre avoir";
    case "reminder_soft":
      return num ? `Rappel courtois : ${input.docLabel ?? "document"} ${num}` : "Rappel courtois";
    case "reminder_firm":
      return num ? `Relance : ${input.docLabel ?? "document"} ${num}` : "Relance";
    case "reminder_formal":
      return num
        ? `Relance formelle : ${input.docLabel ?? "document"} ${num}`
        : "Relance formelle";
    case "access":
      return `Vos identifiants de suivi - ${input.brand.tradeName || input.brand.legalName}`;
    case "onboarding":
      return `Complétez votre fiche client - ${input.brand.tradeName || input.brand.legalName}`;
    case "payment_received":
      return num ? `Paiement reçu : ${num}` : "Paiement reçu";
    default:
      return input.brand.tradeName || "Message";
  }
}

function fmtEur(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

async function bodyTextFor(input: EmailContentInput): Promise<string> {
  const greets = greeting(input.clientFirstName || input.clientName);
  const num = input.docNumber ?? "";
  const portalUrl =
    input.clientPortalUrl?.trim() || (await resolveClientPortalUrl());
  const lines: string[] = [greets, ""];

  switch (input.kind) {
    case "quote":
      lines.push(
        `Veuillez trouver ci-joint le devis ${num || ""}.`.trim(),
        "Je reste disponible pour en discuter.",
        "",
        quoteTrackingBlockText(portalUrl),
      );
      break;
    case "invoice_acompte":
    case "invoice_solde":
    case "invoice":
      lines.push(
        `Veuillez trouver ci-joint ${input.kind === "invoice_acompte" ? "la facture d'acompte" : input.kind === "invoice_solde" ? "la facture de solde" : "la facture"} ${num}.`.trim(),
        "Merci de procéder au règlement selon les conditions indiquées.",
        "",
        invoiceTrackingBlockText(portalUrl),
      );
      if (input.paymentUrl?.trim()) {
        lines.push(...paymentLinesText(input.paymentUrl.trim()));
      }
      break;
    case "credit_note":
      lines.push(`Veuillez trouver ci-joint l'avoir ${num}.`.trim());
      break;
    case "reminder_soft":
      lines.push(
        `Sauf erreur de notre part, le ${input.docLabel ?? "document"} ${num} reste en attente.`,
        "N'hésitez pas si un RIB ou une précision vous manque.",
      );
      if (input.paymentUrl?.trim()) {
        lines.push(...paymentLinesText(input.paymentUrl.trim()));
      }
      break;
    case "reminder_firm":
      lines.push(
        `Je me permets de revenir vers vous concernant le ${input.docLabel ?? "document"} ${num}, toujours en attente de règlement.`,
        "Merci de me confirmer la date de virement prévue.",
      );
      if (input.paymentUrl?.trim()) {
        lines.push(...paymentLinesText(input.paymentUrl.trim()));
      }
      break;
    case "reminder_formal":
      lines.push(
        `Malgré mes précédents rappels, le ${input.docLabel ?? "document"} ${num} demeure impayé.`,
        "Sans règlement sous huit jours, les pénalités de retard prévues au contrat pourront être appliquées, ainsi que l'indemnité forfaitaire de 40 € pour frais de recouvrement.",
      );
      if (input.paymentUrl?.trim()) {
        lines.push(...paymentLinesText(input.paymentUrl.trim()));
      }
      break;
    case "payment_received":
      lines.push(
        input.paidAmountCents != null
          ? `Nous avons bien reçu votre paiement de ${fmtEur(input.paidAmountCents)}${num ? ` (${num})` : ""}.`
          : `Nous avons bien reçu votre paiement${num ? ` pour ${num}` : ""}.`,
        "Merci pour votre confiance.",
      );
      break;
    default:
      if (input.extraLines?.length) lines.push(...input.extraLines);
  }

  if (input.extraLines?.length && ["access", "onboarding"].includes(input.kind)) {
    lines.push(...input.extraLines);
  }

  lines.push("", await resolveEmailSignature(input.brand));
  return lines.join("\n");
}

async function resolveEmailSignature(brand: EmailBrand): Promise<string> {
  const settings = await getCompanySettings();
  return formatPlainTextSignature(settings, brand);
}

export async function buildEmailContent(input: EmailContentInput): Promise<{
  subject: string;
  text: string;
  html?: string;
}> {
  const subject = subjectFor(input);
  const text = await bodyTextFor(input);
  const paymentUrl = input.paymentUrl?.trim();
  if (!paymentUrl) {
    return { subject, text };
  }

  const settings = await getCompanySettings();
  const color = input.brandPrimaryColor ?? settings.brandPrimaryColor ?? "#0f766e";
  const html = renderPaymentButtonHtml({
    url: paymentUrl,
    label: "Payer en ligne",
    brandPrimaryColor: color,
  });
  return { subject, text, html };
}

export async function brandFromSettings(): Promise<EmailBrand> {
  const c = await getCompanySettings();
  return {
    tradeName: c.tradeName ?? c.legalName,
    legalName: c.legalName,
    siret: c.siret,
    email: c.email,
    phone: c.phone,
    website: c.website,
    addressLine1: c.addressLine1,
    postalCode: c.postalCode,
    city: c.city,
  };
}

/** Nom de pièce jointe PDF propre. */
export function pdfAttachmentFilename(
  kind: "Devis" | "Facture" | "Avoir",
  number: string,
  clientName: string,
): string {
  const safeClient = clientName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  const safeNum = number.replace(/[^\w.-]+/g, "_");
  return `${kind}_${safeNum}_${safeClient || "Client"}.pdf`;
}
