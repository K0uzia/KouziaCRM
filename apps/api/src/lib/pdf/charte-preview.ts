import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import type { CompanySettings, Invoice, LegalClause } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { buildInvoicePdfPayload, type BuildPdfPayloadInput } from "@/lib/pdf/build-payload.js";
import { loadBrandLogoDataUrl } from "@/lib/pdf/brand-assets.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { PaymentReceiptDocument } from "@/lib/pdf/payment-receipt-document.js";

/**
 * Aperçu de la charte des documents (Réglages) : rendu réel des gabarits PDF et e-mail à partir de
 * données d'exemple marquées « EXEMPLE ». Lecture seule : rien n'est enregistré, aucun numéro
 * n'est attribué, aucune clause par défaut n'est créée (lecture directe des clauses actives).
 */

export type CharteDraft = {
  brandPrimaryColor: string;
  brandSecondaryColor: string;
  pdfFooterText?: string | null;
  /** current : logo enregistré ; none : aperçu sans logo. */
  logo?: "current" | "none";
};

export type ChartePreviewKind = "QUOTE" | "INVOICE" | "CREDIT_NOTE" | "RECEIPT";

const SAMPLE_NUMBER = "EXEMPLE";
const DAY = 24 * 60 * 60 * 1000;

function draftCompany(company: CompanySettings, draft: CharteDraft): CompanySettings {
  return {
    ...company,
    brandPrimaryColor: draft.brandPrimaryColor,
    brandSecondaryColor: draft.brandSecondaryColor,
    pdfFooterText: draft.pdfFooterText === undefined ? company.pdfFooterText : draft.pdfFooterText?.trim() || null,
  };
}

async function activeClauses(): Promise<LegalClause[]> {
  return prisma.legalClause.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
}

const SAMPLE_CLIENT = {
  displayName: "Client exemple",
  type: "B2B",
  email: null,
  phone: null,
  siret: null,
  addressLine1: "1 rue de l'Exemple",
  addressLine2: null,
  postalCode: "00000",
  city: "Ville exemple",
  country: "France",
};

/** Document fictif au format d'une facture chargée : passe par le même payload que les vrais PDF. */
function sampleInvoice(kind: Exclude<ChartePreviewKind, "RECEIPT">, now: Date): BuildPdfPayloadInput["invoice"] {
  const isQuote = kind === "QUOTE";
  const total = 120_000;
  const doc = {
    id: "exemple",
    number: SAMPLE_NUMBER,
    documentType: kind,
    invoiceType: "SIMPLE",
    status: "ISSUED",
    issueDate: now,
    serviceDate: isQuote ? null : now,
    purchaseOrderRef: null,
    dueDate: isQuote || kind === "CREDIT_NOTE" ? null : new Date(now.getTime() + 30 * DAY),
    validUntil: isQuote ? new Date(now.getTime() + 30 * DAY) : null,
    paymentTerms: null,
    notes: "Document d'exemple : aperçu de la charte, sans valeur.",
    subtotalCents: total,
    totalCents: total,
    discountType: "NONE",
    discountValue: 0,
    refundMethod: kind === "CREDIT_NOTE" ? "OTHER" : null,
    marketTotalCents: null,
    paymentPlanOffer: isQuote ? "NONE" : null,
    paymentPlan: null,
    depositBaseCents: null,
    quoteStatus: null,
    quoteSignerName: null,
    quoteDecidedAt: null,
    creditedInvoice: kind === "CREDIT_NOTE" ? { number: SAMPLE_NUMBER, issueDate: now } : null,
    quote: null,
    sourceMilestone: null,
    milestones: [],
    payments: [],
    quoteAcceptanceAudits: [],
    lines: [
      {
        description: "Prestation d'exemple",
        quantity: 1,
        unitPriceCents: 90_000,
        lineTotalCents: 90_000,
        isSubscription: false,
        billingDay: null,
        billingInterval: null,
        subscriptionStart: null,
      },
      {
        description: "Seconde ligne d'exemple",
        quantity: 2,
        unitPriceCents: 15_000,
        lineTotalCents: 30_000,
        isSubscription: false,
        billingDay: null,
        billingInterval: null,
        subscriptionStart: null,
      },
    ],
  };
  return doc as unknown as Invoice & BuildPdfPayloadInput["invoice"];
}

export async function renderChartePreviewPdf(
  kind: ChartePreviewKind,
  draft: CharteDraft,
  now = new Date(),
): Promise<Buffer> {
  const company = draftCompany(await getCompanySettings(), draft);
  const brandLogoDataUrl = draft.logo === "none" ? null : await loadBrandLogoDataUrl(company.brandLogoPath);

  if (kind === "RECEIPT") {
    const element = React.createElement(PaymentReceiptDocument, {
      specimen: true,
      company: {
        legalName: company.legalName,
        tradeName: company.tradeName,
        siret: company.siret,
        addressLine1: company.addressLine1,
        postalCode: company.postalCode,
        city: company.city,
        email: company.email,
        vatMention: company.vatMention,
        brandPrimaryColor: company.brandPrimaryColor,
        brandSecondaryColor: company.brandSecondaryColor,
        brandLogoDataUrl,
        pdfFooterText: company.pdfFooterText,
      },
      client: SAMPLE_CLIENT,
      payment: { paidAt: now, amountCents: 120_000, methodLabel: "virement", reference: null },
      invoice: { number: SAMPLE_NUMBER, issueDate: now, totalCents: 120_000, label: "Facture" },
      paidToDateCents: 120_000,
      remainingCents: 0,
      issuedAt: now,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Buffer.from(await renderToBuffer(element as any));
  }

  return renderInvoicePdf({
    specimen: true,
    company: { ...company, brandLogoDataUrl },
    client: SAMPLE_CLIENT,
    invoice: buildInvoicePdfPayload({
      invoice: sampleInvoice(kind, now),
      legalClauses: await activeClauses(),
      clientType: SAMPLE_CLIENT.type,
      planSettings: company,
      cgv: { published: company.cgvPublished, url: company.cgvUrl, version: company.cgvVersion },
    }),
  });
}

/** E-mail d'exemple rendu par le gabarit réel des e-mails, avec les couleurs du brouillon. */
export async function renderChartePreviewEmail(draft: CharteDraft): Promise<string> {
  const company = await getCompanySettings();
  const name = company.tradeName || company.legalName;
  const payUrl = "https://exemple.invalid/paiement";
  const text = [
    "Bonjour,",
    `Exemple d'e-mail : voici la facture ${SAMPLE_NUMBER}, d'un montant de 1 200,00 €.`,
    `Payer en ligne : ${payUrl}`,
    `Bonne journée,\n${name}`,
  ].join("\n\n");
  return renderEmailHtml({
    text,
    brand: {
      tradeName: company.tradeName ?? company.legalName,
      legalName: company.legalName,
      siret: company.siret,
      addressLine1: company.addressLine1,
      postalCode: company.postalCode,
      city: company.city,
      website: company.website,
    },
    colors: { brandPrimaryColor: draft.brandPrimaryColor, brandSecondaryColor: draft.brandSecondaryColor },
    paymentUrl: payUrl,
  });
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const compact = (s: string) => s.replace(/[\s.-]/g, "").toLowerCase();

/**
 * Mentions du pied de document déjà imprimées ailleurs sur le PDF (en-tête, total, mentions
 * légales, clauses) : signalées pour éviter les doublons, jamais retirées d'office.
 */
export async function footerDuplicates(footer: string | null | undefined): Promise<string[]> {
  const raw = footer?.trim();
  if (!raw) return [];
  const company = await getCompanySettings();
  const clauses = await activeClauses();
  const text = norm(raw);
  const flat = compact(raw);
  const found = new Set<string>();
  const has = (value: string | null | undefined, min = 4) => {
    const v = value ? norm(value) : "";
    return v.length >= min && text.includes(v);
  };
  const hasCompact = (value: string | null | undefined, min = 6) => {
    const v = value ? compact(value) : "";
    return v.length >= min && flat.includes(v);
  };

  if (has(company.legalName) || has(company.tradeName)) found.add("le nom de l'entreprise (en-tête et pied de page)");
  if (/\bsiren|\bsiret/.test(text) || hasCompact(company.siren, 9) || hasCompact(company.siret, 14)) {
    found.add("le SIREN ou le SIRET (en-tête et mentions légales)");
  }
  if (/\bape\b|\bnaf\b/.test(text) || hasCompact(company.apeCode, 4)) found.add("le code APE (en-tête et mentions légales)");
  if (has(company.addressLine1, 6) || (has(company.postalCode, 5) && has(company.city, 3))) {
    found.add("l'adresse (en-tête)");
  }
  if (has(company.email, 5) || hasCompact(company.phone, 8) || has(company.website?.replace(/^https?:\/\//, ""), 4)) {
    found.add("les coordonnées : e-mail, téléphone ou site (en-tête)");
  }
  if (/tva non applicable|293 ?b/.test(text) || has(company.vatMention, 10)) {
    found.add("la mention de TVA (sous le total et dans les mentions légales)");
  }
  if (/penalite/.test(text) || has(company.latePenaltiesText, 10)) found.add("les pénalités de retard (mentions légales)");
  if (/indemnite forfaitaire|40 ?(€|eur)/.test(text)) found.add("l'indemnité forfaitaire de recouvrement (mentions légales)");
  if (/escompte/.test(text) || has(company.earlyPaymentDiscountText, 10)) found.add("l'escompte (mentions légales)");
  if (/\biban\b|\bbic\b/.test(text) || hasCompact(company.bankIban, 10)) found.add("les coordonnées bancaires (bloc Règlement)");
  if (/micro-entreprise|entrepreneur individuel|\bbnc\b/.test(text)) found.add("le statut de micro-entrepreneur (mentions légales)");
  if (/mediat/.test(text) || has(company.mediationClause, 10)) found.add("la médiation de la consommation (mentions légales, particuliers)");
  if (/assurance|decennale/.test(text) && company.decennaleInsurer) found.add("l'assurance (mentions légales)");
  for (const c of clauses) {
    const body = norm(c.body);
    if (body.length >= 20 && ((text.length >= 20 && body.includes(text)) || text.includes(body.slice(0, 40)))) {
      found.add(`la clause « ${c.title} » (mentions légales)`);
    }
  }
  return [...found];
}
