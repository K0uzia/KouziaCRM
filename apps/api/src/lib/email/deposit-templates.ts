import type { CompanySettings } from "@prisma/client";
import { formatEUR } from "@/lib/money.js";
import type { EmailBrand } from "@/lib/email/templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { templateText } from "@/lib/email/template-registry.js";

export function buildEmailBrand(settings: CompanySettings): EmailBrand {
  return {
    tradeName: settings.tradeName ?? settings.legalName,
    legalName: settings.legalName,
    siret: settings.siret,
    email: settings.email,
    phone: settings.phone,
    website: settings.website,
    addressLine1: settings.addressLine1,
    postalCode: settings.postalCode,
    city: settings.city,
  };
}

function fmtEur(cents: number): string {
  return formatEUR(cents);
}

function greeting(name?: string | null): string {
  const n = name?.trim();
  return n ? `Bonjour ${n},` : "Bonjour,";
}

/**
 * Mot d'une échéance dans les e-mails de lien et de reçu (audit du 28/10/2026), un seul pour les deux : « paiement »
 * pour un paiement comptant, « solde » pour la vraie dernière échéance d'un échéancier, « échéance » pour les autres.
 */
export function instalmentWording(depositIndex: number, depositTotal: number): { nature: string; withArticle: string } {
  if (depositTotal <= 1) return { nature: "paiement", withArticle: "le paiement" };
  if (depositIndex >= depositTotal) return { nature: "solde", withArticle: "le solde" };
  return { nature: "échéance", withArticle: "l'échéance" };
}

export async function renderDepositCheckoutEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml">;
  brandPrimaryColor: string;
  clientFirstName?: string | null;
  clientName: string;
  quoteNumber: string;
  amountCents: number;
  checkoutUrl: string;
  depositIndex: number;
  depositTotal: number;
  label?: string;
}) {
  const word = instalmentWording(opts.depositIndex, opts.depositTotal).withArticle;
  const original = {
    subject: `Devis validé : réglez ${word}`,
    body: [
      greeting(opts.clientFirstName ?? opts.clientName),
      "",
      `Votre devis ${opts.quoteNumber} est validé. Merci de régler ${word} (${fmtEur(opts.amountCents)}).`,
      "",
      `Payer en ligne : ${opts.checkoutUrl}`,
    ].join("\n"),
  };
  // Modèle modifié dans Réglages (M3a) : objet et texte remplis ; sinon le texte ci-dessus.
  const content = await templateText(
    "payment.deposit_link",
    {
      salutation: greeting(opts.clientFirstName ?? opts.clientName),
      prenom: opts.clientFirstName?.trim() ?? "",
      client: opts.clientName,
      devis: opts.quoteNumber,
      echeance: word,
      montant: fmtEur(opts.amountCents),
      libelle_jalon: opts.label ?? "",
      lien_paiement: opts.checkoutUrl,
    },
    original,
  );
  const subject = content.subject;
  const text = [content.body, "", formatPlainTextSignature(opts.settings, opts.brand)].join("\n");

  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: { brandPrimaryColor: opts.brandPrimaryColor },
    paymentUrl: opts.checkoutUrl,
    paymentLabel: "Payer maintenant",
  });

  return { subject, text, html };
}

export async function renderDepositPaidEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml">;
  clientFirstName?: string | null;
  clientName: string;
  quoteNumber: string;
  amountCents: number;
  depositIndex: number;
  depositTotal: number;
  label?: string;
}) {
  const kind = instalmentWording(opts.depositIndex, opts.depositTotal).nature;
  const content = await templateText(
    "payment.deposit_paid",
    {
      salutation: greeting(opts.clientFirstName ?? opts.clientName),
      prenom: opts.clientFirstName?.trim() ?? "",
      client: opts.clientName,
      devis: opts.quoteNumber,
      nature: kind,
      montant: fmtEur(opts.amountCents),
    },
    {
      subject: `Paiement reçu : ${kind} - devis ${opts.quoteNumber}`,
      body: [
        greeting(opts.clientFirstName ?? opts.clientName),
        "",
        `Nous avons bien reçu votre paiement de ${fmtEur(opts.amountCents)} (${kind} sur le devis ${opts.quoteNumber}).`,
        "Merci pour votre confiance.",
      ].join("\n"),
    },
  );
  const subject = content.subject;
  const text = [content.body, "", formatPlainTextSignature(opts.settings, opts.brand)].join("\n");

  return { subject, text };
}

export function renderDepositFailedAdminEmail(opts: {
  brand: EmailBrand;
  quoteNumber: string;
  amountCents: number;
  clientName: string;
  reason: string;
  isSuccess: boolean;
}) {
  const subject = opts.isSuccess
    ? `[Kouzia] Acompte payé - ${opts.quoteNumber}`
    : `[Kouzia] Paiement échoué - ${opts.quoteNumber}`;
  const text = [
    opts.isSuccess ? "Acompte encaissé" : "Échec de paiement",
    "",
    `Devis : ${opts.quoteNumber}`,
    `Client : ${opts.clientName}`,
    `Montant : ${fmtEur(opts.amountCents)}`,
    `Détail : ${opts.reason}`,
  ].join("\n");

  return { subject, text };
}
