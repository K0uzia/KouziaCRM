import type { CompanySettings } from "@prisma/client";
import { centsToEuros } from "@/lib/money.js";
import {
  renderPaymentButtonHtml,
  type EmailBrand,
} from "@/lib/email/templates.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";

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
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(centsToEuros(cents));
}

function greeting(name?: string | null): string {
  const n = name?.trim();
  return n ? `Bonjour ${n},` : "Bonjour,";
}

export function renderDepositCheckoutEmail(opts: {
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
  const isSolde =
    opts.depositIndex === opts.depositTotal ||
    /solde/i.test(opts.label ?? "");
  const subject = isSolde
    ? `Devis validé : réglez le solde`
    : `Devis validé : réglez l'acompte`;
  const what = isSolde
    ? `le solde (${fmtEur(opts.amountCents)})`
    : `l'acompte (${fmtEur(opts.amountCents)})`;
  const text = [
    greeting(opts.clientFirstName ?? opts.clientName),
    "",
    `Votre devis ${opts.quoteNumber} est validé. Merci de régler ${what}.`,
    "",
    `Payer en ligne : ${opts.checkoutUrl}`,
    "",
    formatPlainTextSignature(opts.settings, opts.brand),
  ].join("\n");

  const html = renderPaymentButtonHtml({
    url: opts.checkoutUrl,
    label: "Payer maintenant",
    brandPrimaryColor: opts.brandPrimaryColor,
  });

  return { subject, text, html };
}

export function renderDepositPaidEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml">;
  clientFirstName?: string | null;
  clientName: string;
  quoteNumber: string;
  amountCents: number;
  depositIndex: number;
  label?: string;
}) {
  const isSolde = /solde/i.test(opts.label ?? "");
  const kind = isSolde ? "solde" : "acompte";
  const subject = `Paiement reçu : ${kind} - devis ${opts.quoteNumber}`;
  const text = [
    greeting(opts.clientFirstName ?? opts.clientName),
    "",
    `Nous avons bien reçu votre paiement de ${fmtEur(opts.amountCents)} (${kind} sur le devis ${opts.quoteNumber}).`,
    "Merci pour votre confiance.",
    "",
    formatPlainTextSignature(opts.settings, opts.brand),
  ].join("\n");

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
    opts.isSuccess ? "Acompte encaissé" : "Échec de paiement Revolut",
    "",
    `Devis : ${opts.quoteNumber}`,
    `Client : ${opts.clientName}`,
    `Montant : ${fmtEur(opts.amountCents)}`,
    `Détail : ${opts.reason}`,
  ].join("\n");

  return { subject, text };
}
