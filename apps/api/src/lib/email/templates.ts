import { getCompanySettings } from "@/lib/company";

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
  | "onboarding";

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
};

function greeting(name?: string | null): string {
  const n = name?.trim();
  return n ? `Bonjour ${n},` : "Bonjour,";
}

function signature(brand: EmailBrand): string {
  return [
    "Cordialement,",
    brand.tradeName || brand.legalName,
    brand.legalName,
    `EI · SIRET ${brand.siret}`,
    [brand.addressLine1, `${brand.postalCode} ${brand.city}`].filter(Boolean).join(", "),
    brand.email || "",
    brand.website || "",
  ]
    .filter(Boolean)
    .join("\n");
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
    default:
      return input.brand.tradeName || "Message";
  }
}

function bodyTextFor(input: EmailContentInput): string {
  const greets = greeting(input.clientFirstName || input.clientName);
  const num = input.docNumber ?? "";
  const lines: string[] = [greets, ""];

  switch (input.kind) {
    case "quote":
      lines.push(
        `Veuillez trouver ci-joint le devis ${num || ""}.`.trim(),
        "Je reste disponible pour en discuter.",
      );
      break;
    case "invoice_acompte":
      lines.push(
        `Veuillez trouver ci-joint la facture d'acompte ${num}.`.trim(),
        "Merci de procéder au règlement selon les conditions indiquées.",
      );
      break;
    case "invoice_solde":
      lines.push(
        `Veuillez trouver ci-joint la facture de solde ${num}.`.trim(),
        "Merci de procéder au règlement selon les conditions indiquées.",
      );
      break;
    case "invoice":
      lines.push(
        `Veuillez trouver ci-joint la facture ${num}.`.trim(),
        "Merci de procéder au règlement selon les conditions indiquées.",
      );
      break;
    case "credit_note":
      lines.push(`Veuillez trouver ci-joint l'avoir ${num}.`.trim());
      break;
    case "reminder_soft":
      lines.push(
        `Sauf erreur de notre part, le ${input.docLabel ?? "document"} ${num} reste en attente.`,
        "N'hésitez pas si un RIB ou une précision vous manque.",
      );
      break;
    case "reminder_firm":
      lines.push(
        `Je me permets de revenir vers vous concernant le ${input.docLabel ?? "document"} ${num}, toujours en attente de règlement.`,
        "Merci de me confirmer la date de virement prévue.",
      );
      break;
    case "reminder_formal":
      lines.push(
        `Malgré mes précédents rappels, le ${input.docLabel ?? "document"} ${num} demeure impayé.`,
        "Sans règlement sous huit jours, les pénalités de retard prévues au contrat pourront être appliquées, ainsi que l'indemnité forfaitaire de 40 € pour frais de recouvrement.",
      );
      break;
    default:
      if (input.extraLines?.length) lines.push(...input.extraLines);
  }

  if (input.extraLines?.length && input.kind !== "access" && input.kind !== "onboarding") {
    // already handled for default
  }
  if (input.extraLines?.length && ["access", "onboarding"].includes(input.kind)) {
    lines.push(...input.extraLines);
  }

  lines.push("", signature(input.brand));
  return lines.join("\n");
}

/** HTML email-safe (tables, styles inline, largeur 600px). */
export function renderEmailHtml(textBody: string, brand: EmailBrand): string {
  const paragraphs = textBody
    .split("\n")
    .map((line) =>
      line.trim() === ""
        ? "<br/>"
        : `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#111827;">${escapeHtml(line)}</p>`,
    )
    .join("");

  const brandName = escapeHtml(brand.tradeName || brand.legalName);
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#f6f7f8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
        <tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
          <p style="margin:0;font-size:18px;font-weight:600;color:#0f766e;">${brandName}</p>
        </td></tr>
        <tr><td style="padding:24px;">${paragraphs}</td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
          ${escapeHtml(brand.legalName)} · SIRET ${escapeHtml(brand.siret)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildEmailContent(input: EmailContentInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = subjectFor(input);
  const text = bodyTextFor(input);
  return { subject, text, html: renderEmailHtml(text, input.brand) };
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
