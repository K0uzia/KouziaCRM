import React, { Fragment } from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
  Font,
} from "@react-pdf/renderer";
import { Readable } from "@/lib/pdf/readable.js";
import type { PdfCompanySettings } from "@/lib/pdf/brand-assets.js";
import { fillClauseVariables } from "@/lib/company/legal-clauses.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import { formatEUR } from "@/lib/money.js";
import { discountSentence, type RecurringDiscountSummary } from "@/lib/quotes/recurring-discount.js";
import { readableOn, resolveBrandColors } from "@/lib/brand.js";
import { formatDateFr, formatDateTimeShortFr } from "@/lib/format-fr.js";

/**
 * Charte Kouzia adaptée à l'impression : fond blanc, encre nuit, ambre en aplats
 * (jamais en texte sur blanc, contraste insuffisant). Polices standard PDF (WinAnsi) :
 * pas de caractère hors de cet encodage (espace fine, signe moins typographique…).
 */
// Pas de césure automatique : « docu-ment », « fac-ture » nuisent à la lecture d'un document légal.
Font.registerHyphenationCallback((word) => [word]);

const INK = "#0b1020";
const TEXT = "#1f2433";
const MUTED = "#5b6478";
const LINE = "#e3e6ee";
const SOFT = "#f5f6fa";

function createStyles(primary: string, secondary: string) {
  return StyleSheet.create({
    page: {
      paddingTop: 34,
      paddingBottom: 56,
      paddingHorizontal: 40,
      fontSize: 9.5,
      fontFamily: "Helvetica",
      color: TEXT,
    },
    accent: { position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: primary },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: 24,
      marginBottom: 22,
    },
    logo: { width: 64, height: 64, objectFit: "contain", marginBottom: 8 },
    brand: { fontSize: 18, lineHeight: 1.2, fontFamily: "Helvetica-Bold", color: secondary, marginBottom: 5 },
    muted: { color: MUTED, fontSize: 8.5, lineHeight: 1.45 },
    docBlock: { alignItems: "flex-end", minWidth: 190 },
    docKind: {
      fontSize: 8,
      fontFamily: "Helvetica-Bold",
      letterSpacing: 1.5,
      color: MUTED,
    },
    docNumber: { fontSize: 17, lineHeight: 1.2, fontFamily: "Helvetica-Bold", color: secondary, marginTop: 3 },
    docMeta: { marginTop: 8, alignItems: "flex-end" },
    metaRow: { flexDirection: "row", gap: 6, marginTop: 1.5 },
    metaLabel: { color: MUTED, fontSize: 8.5 },
    metaValue: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: INK },
    parties: { flexDirection: "row", gap: 16, marginBottom: 18 },
    party: {
      flex: 1,
      padding: 12,
      // Fond doux seul : la hiérarchie vient du titre (FACTURÉ À, CONDITIONS), pas d'une bordure d'accent.
      backgroundColor: SOFT,
    },
    partyTitle: {
      fontSize: 7.5,
      fontFamily: "Helvetica-Bold",
      letterSpacing: 1.2,
      color: MUTED,
      marginBottom: 5,
    },
    partyName: { fontSize: 11, fontFamily: "Helvetica-Bold", color: INK, marginBottom: 2 },
    h2: {
      fontSize: 10,
      fontFamily: "Helvetica-Bold",
      marginBottom: 6,
      color: secondary,
    },
    section: { marginTop: 18 },
    proposalIntro: { marginTop: 4, fontFamily: "Helvetica-Bold", color: INK },
    proposal: { marginTop: 16, paddingTop: 10, borderTopWidth: 1, borderColor: LINE },
    proposalTitle: { marginBottom: 6, fontSize: 12, fontFamily: "Helvetica-Bold", color: INK },
    box: { padding: 12, borderWidth: 1, borderColor: LINE, backgroundColor: SOFT },
    table: { marginTop: 4 },
    groupRow: {
      paddingTop: 10,
      paddingBottom: 4,
      paddingHorizontal: 8,
      borderBottomWidth: 1,
      borderColor: LINE,
      fontFamily: "Helvetica-Bold",
      color: INK,
    },
    tr: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderColor: LINE,
      paddingVertical: 8,
      paddingHorizontal: 8,
    },
    th: {
      flexDirection: "row",
      backgroundColor: secondary,
      color: readableOn(secondary),
      fontFamily: "Helvetica-Bold",
      fontSize: 8,
      letterSpacing: 0.6,
      paddingVertical: 7,
      paddingHorizontal: 8,
    },
    colDesc: { flex: 3.4, paddingRight: 10 },
    colQty: { flex: 0.6, textAlign: "right" },
    colPrice: { flex: 1.3, textAlign: "right" },
    colTotal: { flex: 1.3, textAlign: "right", fontFamily: "Helvetica-Bold" },
    colPayDate: { flex: 1.2 },
    colPayMethod: { flex: 1.4 },
    colPayRef: { flex: 1.4 },
    colPayAmount: { flex: 1, textAlign: "right" },
    lineNote: { marginTop: 3, fontSize: 8, lineHeight: 1.4, color: MUTED },
    totals: { marginTop: 14, alignSelf: "flex-end", width: 240 },
    totalLine: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 4,
      paddingHorizontal: 10,
    },
    grandTotal: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 4,
      paddingVertical: 9,
      paddingHorizontal: 10,
      backgroundColor: primary,
      color: readableOn(primary),
    },
    grandLabel: { fontSize: 10, fontFamily: "Helvetica-Bold" },
    grandValue: { fontSize: 13, fontFamily: "Helvetica-Bold" },
    vat: { marginTop: 4, fontSize: 7.5, color: MUTED, textAlign: "right" },
    settled: {
      marginTop: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderWidth: 1.5,
      borderColor: "#15803d",
      backgroundColor: "#f0fdf4",
      alignItems: "center",
    },
    settledTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: "#15803d", letterSpacing: 1.2 },
    milestone: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderColor: LINE,
      paddingVertical: 6,
      paddingHorizontal: 8,
      gap: 8,
    },
    payBox: {
      marginTop: 18,
      padding: 12,
      // Contour complet de 1 px, titre en gras : pas de bordure gauche d'accent (règle web-design).
      borderWidth: 1,
      borderColor: LINE,
    },
    strong: { fontFamily: "Helvetica-Bold", color: INK },
    signRow: { flexDirection: "row", gap: 12, marginTop: 6 },
    signCol: { flex: 1 },
    signName: { fontSize: 11, fontFamily: "Helvetica-Bold", color: INK },
    signImage: { width: 160, height: 60, objectFit: "contain", marginVertical: 4 },
    signTyped: { fontSize: 13, fontFamily: "Helvetica-Oblique", color: INK, marginVertical: 8 },
    proof: { flex: 1, padding: 8, backgroundColor: "#f8fafc", borderWidth: 1, borderColor: LINE },
    proofTitle: { fontSize: 8, fontFamily: "Helvetica-Bold", color: INK, letterSpacing: 0.6, marginBottom: 3 },
    legal: {
      marginTop: 24,
      paddingTop: 10,
      borderTopWidth: 1,
      borderColor: LINE,
      fontSize: 7.5,
      color: MUTED,
      lineHeight: 1.45,
    },
    footerRule: { position: "absolute", bottom: 34, left: 40, right: 40, height: 1, backgroundColor: LINE },
    footerLeft: { position: "absolute", bottom: 22, left: 40, fontSize: 7.5, color: MUTED },
    footerRight: { position: "absolute", bottom: 22, left: 40, right: 40, fontSize: 7.5, color: MUTED, textAlign: "right" },
    specimen: {
      position: "absolute",
      top: 360,
      left: 0,
      right: 0,
      textAlign: "center",
      fontSize: 96,
      fontFamily: "Helvetica-Bold",
      color: LINE,
      transform: "rotate(-30deg)",
    },
  });
}

function formatIban(iban: string): string {
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  return clean.replace(/(.{4})/g, "$1 ").trim();
}

function fmtDate(d: Date) {
  return formatDateFr(d);
}

function fmtDateTime(d: Date) {
  return formatDateTimeShortFr(d);
}

/** 3f9a1c2e…7b40c21e : assez pour comparer à l'empreinte complète archivée. */
function shortHash(hex: string) {
  return `${hex.slice(0, 16)}…${hex.slice(-16)}`;
}

function fmtMoney(cents: number) {
  return formatEUR(cents);
}

/** « par an », « par trimestre », « par mois » : période d'un abonnement (null en base = mensuel). */
const PERIOD_WORD: Record<string, string> = { YEAR: "an", QUARTER: "trimestre", MONTH: "mois" };
const periodWord = (interval: string | null | undefined) => PERIOD_WORD[interval ?? "MONTH"] ?? "mois";
const intervalOf = (interval: string | null | undefined) => (interval === "YEAR" || interval === "QUARTER" ? interval : "MONTH");
/** Périodicité de la clause d'engagement : celle de la 1re ligne engagée (un abonnement par devis récurrent). */
const commitmentInterval = (lines: ReadonlyArray<{ isSubscription?: boolean; commitmentMonths?: number | null; billingInterval?: string | null }>) =>
  intervalOf(lines.find((l) => l.isSubscription && l.commitmentMonths)?.billingInterval);

/** Remise d'un devis récurrent : quoi (pourcentage ou montant par échéance) et sur quelles échéances. */
function discountWords(d: RecurringDiscountSummary) {
  const what = d.kind === "PERCENT" ? `${String(d.value / 100).replace(".", ",")} %` : `${fmtMoney(d.value)} par échéance`;
  const span = d.months == null ? "sur toute la durée de l’engagement" : d.periods === 1 ? "sur la 1re échéance" : `sur les ${d.periods} premières échéances`;
  const label = d.promoCode ? `Code promo ${d.promoCode} : ${what} ${span}` : d.opening ? `Remise d’ouverture : ${what} sur les ${d.months} premiers mois` : `Remise : ${what} ${span}`;
  return { what, span, label };
}

function subscriptionHeading(lines: Array<{ isSubscription?: boolean; billingInterval?: string | null; commitmentMonths?: number | null }>) {
  const subs = lines.filter((l) => l.isSubscription);
  if (subs.every((l) => l.commitmentMonths)) return "Abonnement avec engagement";
  if (subs.every((l) => l.billingInterval === "YEAR")) return "Engagement d'abonnement annuel";
  if (subs.every((l) => l.billingInterval === "QUARTER")) return "Engagement d'abonnement trimestriel";
  if (subs.every((l) => l.billingInterval !== "YEAR" && l.billingInterval !== "QUARTER")) return "Engagement d'abonnement mensuel";
  return "Engagement d'abonnement";
}

/** Engagement d'un devis signé : CGV et délai de rétractation, tels que figés dans la preuve. */
function SignatureTermsLines({
  acceptance,
  muted,
}: {
  acceptance: NonNullable<InvoicePdfData["invoice"]["acceptance"]>;
  muted: ReturnType<typeof createStyles>["muted"];
}) {
  return (
    <>
      {acceptance.cgvAccepted === false ? <Text style={muted}>CGV non acceptées en ligne.</Text> : null}
      {acceptance.consumer && acceptance.withdrawalEndsAt ? (
        <Text style={muted}>
          Délai de rétractation jusqu'au {fmtDate(acceptance.withdrawalEndsAt)} inclus.{" "}
          {acceptance.expressExecution
            ? "Exécution demandée par le client avant la fin de ce délai."
            : "Sans demande d'exécution anticipée : démarrage au plus tôt le lendemain."}
        </Text>
      ) : null}
    </>
  );
}

function fmtQty(q: number) {
  return Number.isInteger(q) ? String(q) : String(q).replace(".", ",");
}

export type InvoicePdfData = {
  company: PdfCompanySettings;
  client: ClientSnapshot;
  /** Aperçu de la charte (Réglages) : filigrane « EXEMPLE » sur chaque page, aucun document réel. */
  specimen?: boolean;
  /** Aperçu d'un brouillon avant création : filigrane « APERÇU » et numéro provisoire (attribué à l'émission). */
  draft?: boolean;
  invoice: {
    number: string;
    documentType: "INVOICE" | "CREDIT_NOTE" | "QUOTE";
    invoiceType?: "SIMPLE" | "ACOMPTE" | "SOLDE";
    issueDate: Date;
    serviceDate?: Date | null;
    purchaseOrderRef?: string | null;
    dueDate: Date | null;
    validUntil?: Date | null;
    paymentTerms: string | null;
    notes: string | null;
    subtotalCents: number;
    totalCents: number;
    discountType?: "NONE" | "PERCENT" | "FIXED";
    discountValue?: number;
    creditedInvoiceNumber: string | null;
    creditedInvoiceIssueDate?: Date | null;
    refundMethod?: "BANK_TRANSFER" | "DEDUCT_FROM_BALANCE" | "OTHER" | null;
    nothingToPay?: boolean;
    quoteNumber?: string | null;
    quoteIssueDate?: Date | null;
    marketTotalCents?: number | null;
    milestoneTrigger?: string | null;
    /** Facture du 2e acompte (3 fois) : étape de projet qui l'a rendu exigible. */
    milestoneTriggerStep?: { label: string; at: Date | null } | null;
    /** Devis au choix, non signé : un échéancier par formule. */
    paymentPlanChoice?: Array<{
      title: string;
      milestones: Array<{ label: string; percentBps: number; amountCents: number; triggerText: string }>;
    }> | null;
    /** Devis signé : formule retenue par le client. */
    paymentPlanRetained?: string | null;
    /** Devis d'abonnement seul : facturé à partir de la signature, sans acompte. */
    subscriptionOnly?: boolean;
    /** Devis mixte : l'abonnement est facturé à partir de la livraison, hors échéancier. */
    subscriptionFromDelivery?: boolean;
    /** Devis mixte : total du projet puis abonnements à part (null sinon). */
    mixedTotals?: {
      oneOffCents: number;
      discountCents: number;
      projectCents: number;
      subscriptions: Array<{ label: string; text: string }>;
      yearCents: number;
      monthCents: number;
    } | null;
    balanceSummary?: {
      marketTotalCents: number;
      quoteNumber: string | null;
      acomptes: Array<{
        number: string;
        amountCents: number;
        paid: boolean;
        label: string;
        deductedCents: number;
      }>;
      balanceDueCents: number;
    } | null;
    milestones?: Array<{
      label: string;
      percentBps: number;
      amountCents: number;
      triggerText: string;
      status?: string;
      dueDate?: Date | null;
    }>;
    payments?: Array<{
      paidAt: Date;
      amountCents: number;
      method: string;
      reference?: string | null;
      status?: string;
    }>;
    /** Avoirs émis sur la facture et sommes remboursées par eux (rendu de secours d'une facture sans archive). */
    creditedCents?: number;
    refundedCents?: number;
    /**
     * Devis accepté. Signé depuis l'espace client : mode, tracé, adresse ayant reçu
     * le code, n° de preuve et empreinte du devis avant signature. Sinon (validation
     * par l'administrateur) : nom et date seulement.
     */
    acceptance?: {
      signerName: string;
      acceptedAt: Date;
      company?: string | null;
      mode?: "TYPED" | "DRAWN";
      image?: string | null;
      emailMasked?: string | null;
      /** Signature par session /suivi : heure de connexion (code de connexion) ; null : code de signature. */
      sessionLoginAt?: Date | null;
      proofId?: string | null;
      documentSha256?: string | null;
      /** null : signature antérieure au suivi des CGV et du délai de rétractation. */
      cgvAccepted?: boolean | null;
      consumer?: boolean | null;
      expressExecution?: boolean | null;
      withdrawalEndsAt?: Date | null;
    } | null;
    /** Clauses de l'encadré d'abonnement par périodicité (Réglages > Clauses). */
    /** COMMITMENT : lignes avec durée d'engagement, à la place de la clause de leur périodicité. */
    subscriptionTerms?: { MONTH: string | null; YEAR: string | null; QUARTER?: string | null; COMMITMENT?: string | null };
    /** Devis récurrent : l'abonnement par période, engagement et total sur la durée. */
    recurringSummary?: {
      period: "MONTH" | "QUARTER" | "YEAR";
      amountCents: number;
      commitmentMonths: number | null;
      periods: number | null;
      totalCommitmentCents: number | null;
      startText: string;
      /** Départ seul, sans le prix (absent d'un payload plus ancien : phrase complète startText). */
      startFromText?: string;
      billingDay?: number | null;
      /** Remise sur les premières échéances (R1) ; absente sans remise. */
      discount?: RecurringDiscountSummary | null;
    } | null;
    /** Droit de rétractation et formulaire type : devis d'un client particulier. */
    withdrawalTerms?: string | null;
    /** Devis avec abonnement : date de prélèvement à changer par un refus motivé (clause dédiée), sous les totaux. */
    subscriptionDateNotice?: string | null;
    /** CGV applicables : version acceptée à la signature, sinon version publiée en vigueur. */
    cgv?: { url: string; version: string } | null;
    lines: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      lineTotalCents: number;
      isSubscription?: boolean;
      /** false : abonnement à 1re facture repoussée, hors tableau et hors total (seulement dans l'engagement d'abonnement). */
      inTotal?: boolean;
      billingDay?: number | null;
      billingInterval?: string | null;
      /** Départ choisi sur la ligne du devis, en clair : « 12 mois offerts à partir de la livraison du projet, puis 72,00 € par an ». */
      startText?: string | null;
      /** Ligne d'abonnement : durée d'engagement en mois ; null = sans engagement. */
      commitmentMonths?: number | null;
      /** Pack : titre sous lequel la ligne est groupée ; ligne de remise du pack. */
      groupTitle?: string | null;
      isPackDiscount?: boolean;
    }>;
    legalClauses?: Array<{ title: string; body: string }>;
    /** Devis à propositions (P2) : corps de chaque proposition (lignes, totaux, abonnement, échéancier), dans l'ordre. */
    proposals?: Array<{ heading: string; invoice: InvoicePdfData["invoice"] }> | null;
    /** Devis signé à propositions : « A : Paiement unique ». */
    selectedProposal?: string | null;
  };
};

type PdfInvoice = InvoicePdfData["invoice"];

/**
 * Règlements : facture acquittée (vaut reçu) ou reste dû, avoirs compris (net = total - avoirs, encaissé net des
 * remboursements). Une facture archivée à l'émission n'a ni règlement ni avoir : ce bloc sert au rendu de secours.
 */
function settlementOf(invoice: PdfInvoice) {
  const isQuote = invoice.documentType === "QUOTE";
  const isCredit = invoice.documentType === "CREDIT_NOTE";
  const creditedCents = invoice.creditedCents ?? 0;
  const paidCents = (invoice.payments ?? []).reduce((s, p) => s + p.amountCents, 0) - (invoice.refundedCents ?? 0);
  const netCents = Math.max(0, invoice.totalCents - creditedCents);
  const dueCents = Math.max(0, netCents - paidCents);
  const showSettlement = !isQuote && !isCredit && (paidCents > 0 || creditedCents > 0);
  const settled = showSettlement && dueCents === 0;
  const lastPaidAt = (invoice.payments ?? []).reduce<Date | null>((d, p) => (!d || p.paidAt > d ? p.paidAt : d), null);
  return { creditedCents, paidCents, dueCents, showSettlement, settled, lastPaidAt };
}

/**
 * Corps d'un document : lignes, totaux, encadré d'abonnement et échéancier. Une fois pour un document, une fois par
 * proposition pour un devis à propositions (chacune a son mode, ses prestations, sa remise et son échéancier).
 */
function DocumentBody({ company, invoice, styles }: { company: PdfCompanySettings; invoice: PdfInvoice; styles: ReturnType<typeof createStyles> }) {
  const isCredit = invoice.documentType === "CREDIT_NOTE";
  const isQuote = invoice.documentType === "QUOTE";
  // Clauses de l'encadré d'un devis récurrent : engagement pour les lignes engagées, périodicité pour les autres.
  const subLines = invoice.lines.filter((l) => l.isSubscription);
  const recurringClauses = invoice.recurringSummary
    ? [
        ...(["MONTH", "QUARTER", "YEAR"] as const)
          .filter((iv) => subLines.some((l) => !l.commitmentMonths && intervalOf(l.billingInterval) === iv) && invoice.subscriptionTerms?.[iv])
          .map((iv) => fillClauseVariables(invoice.subscriptionTerms![iv]!, company, iv)),
        ...(invoice.subscriptionTerms?.COMMITMENT && subLines.some((l) => l.commitmentMonths)
          ? [fillClauseVariables(invoice.subscriptionTerms.COMMITMENT, company, commitmentInterval(invoice.lines))]
          : []),
      ]
    : [];
  const { creditedCents, paidCents, dueCents, showSettlement, settled, lastPaidAt } = settlementOf(invoice);
  const hasDiscount = invoice.discountType && invoice.discountType !== "NONE" && invoice.subtotalCents !== invoice.totalCents;
  return (
    <>
        <Readable as="table">
        <View style={styles.table}>
          <Readable as="headRow">
          <View style={styles.th} fixed>
            <Text style={styles.colDesc}>DÉSIGNATION</Text>
            <Text style={styles.colQty}>QTÉ</Text>
            <Text style={styles.colPrice}>PRIX UNITAIRE</Text>
            <Text style={[styles.colTotal, { fontFamily: "Helvetica-Bold" }]}>MONTANT</Text>
          </View>
          </Readable>
          {invoice.lines.filter((l) => l.inTotal !== false).map((line, i, shown) => (
            <Fragment key={i}>
            {/* Pack : titre au-dessus de ses lignes, détail et remise compris. */}
            {line.groupTitle && line.groupTitle !== shown[i - 1]?.groupTitle ? (
              <Text style={styles.groupRow} minPresenceAhead={40}>
                {line.groupTitle}
              </Text>
            ) : null}
            <Readable as="row">
            <View
              style={[styles.tr, i % 2 === 1 ? { backgroundColor: SOFT } : {}]}
              wrap={false}
            >
              <View style={[styles.colDesc, line.groupTitle ? { paddingLeft: 8 } : {}]}>
                <Text style={{ color: INK }}>{line.description}</Text>
                {/* Devis récurrent : la ligne ne porte que la désignation ; rythme, départ, engagement et équivalent
                    mensuel sont sous le total, une seule fois. */}
                {line.isSubscription && !invoice.recurringSummary ? (
                  <Text style={styles.lineNote}>
                    {line.billingInterval === "YEAR"
                      ? "Abonnement annuel, facturé chaque année à la date anniversaire"
                      : line.billingInterval === "QUARTER"
                        ? `Abonnement trimestriel, facturé chaque trimestre${line.billingDay ? ` le ${line.billingDay}` : ""}`
                        : `Abonnement mensuel, facturé chaque mois${line.billingDay ? ` le ${line.billingDay}` : ""}`}{" "}
                    : {fmtMoney(line.unitPriceCents)}.{" "}
                    {line.startText
                      ? `Facturation : ${line.startText}.`
                      : invoice.subscriptionOnly
                        ? "Facturé à partir de la signature, sans acompte."
                        : invoice.subscriptionFromDelivery
                          ? "Facturé à partir de la livraison, hors acompte et échéancier."
                          : "Ce document inclut la 1re échéance."}
                  </Text>
                ) : null}
                {/* Devis seulement : équivalent mensuel d'un prix annuel, en information. Le prix dû reste l'annuel
                    (colonnes et total) ; jamais sur la facture, dont le montant dû est l'annuel. */}
                {isQuote && !invoice.recurringSummary && line.isSubscription && line.billingInterval === "YEAR" && line.unitPriceCents > 0 ? (
                  <Text style={styles.lineNote}>{`Soit ${fmtMoney(Math.round(line.unitPriceCents / 12))} par mois, à titre indicatif.`}</Text>
                ) : null}
              </View>
              <Text style={styles.colQty}>{fmtQty(line.quantity)}</Text>
              <Text style={styles.colPrice}>{fmtMoney(line.unitPriceCents)}</Text>
              <Text style={styles.colTotal}>{fmtMoney(line.lineTotalCents)}</Text>
            </View>
            </Readable>
            </Fragment>
          ))}
          {invoice.recurringSummary?.discount ? (
            <Readable as="row">
            <View style={styles.tr} wrap={false}>
              <View style={styles.colDesc}>
                <Text style={{ color: INK }}>{discountWords(invoice.recurringSummary.discount).label}</Text>
              </View>
              <Text style={styles.colQty}>{""}</Text>
              <Text style={styles.colPrice}>{""}</Text>
              <Text style={styles.colTotal}>{`- ${fmtMoney(invoice.recurringSummary.discount.discountCentsPerPeriod)}`}</Text>
            </View>
            </Readable>
          ) : null}
        </View>
        </Readable>

        <Readable as="totals">
        <View style={styles.totals} wrap={false}>
          {invoice.recurringSummary ? (
            <>
              <Readable as="mainPair">
              <View style={styles.grandTotal}>
                <Text style={styles.grandLabel}>Abonnement</Text>
                <Text style={styles.grandValue}>
                  {`${fmtMoney(invoice.recurringSummary.amountCents)} / ${periodWord(invoice.recurringSummary.period)}`}
                </Text>
              </View>
              </Readable>
              {(() => {
                // Une information par phrase, une seule fois sur le document : rythme, départ, engagement, total sur la
                // durée, puis l'équivalent mensuel indicatif d'un prix annuel ou trimestriel.
                const r = invoice.recurringSummary;
                const day = r.billingDay ? ` le ${r.billingDay}` : "";
                const rhythm =
                  r.period === "YEAR" ? "chaque année à la date anniversaire" : r.period === "QUARTER" ? `chaque trimestre${day}` : `chaque mois${day}`;
                const engaged = r.commitmentMonths && r.periods && r.totalCommitmentCents !== null;
                const d = r.discount;
                const per = `par ${periodWord(r.period)}`;
                const sentences = [
                  ...(d
                    ? [
                        discountSentence(d, r.amountCents, r.period, fmtMoney),
                        ...(d.opening ? ["Remise d’ouverture : structure créée il y a moins de 12 mois."] : []),
                        ...(d.promoCode && d.condition ? [`Code promo ${d.promoCode} : ${d.condition.replace(/\.$/, "")}.`] : []),
                      ]
                    : []),
                  `Facturé ${rhythm}.`,
                  r.startFromText ? `Départ de la facturation : ${r.startFromText}.` : `Facturation : ${r.startText}.`,
                  engaged ? `Engagement de ${r.commitmentMonths} mois à compter de la signature.` : "[Engagement à choisir : 12, 24 ou 36 mois]",
                  ...(engaged ? [`Total sur la durée de l'engagement : ${fmtMoney(r.totalCommitmentCents!)} (${r.periods} échéance${r.periods! > 1 ? "s" : ""}).`] : []),
                  ...(r.period !== "MONTH" && r.amountCents > 0
                    ? [`Soit ${fmtMoney(Math.round(r.amountCents / (r.period === "YEAR" ? 12 : 3)))} par mois, à titre indicatif.`]
                    : []),
                ];
                return sentences.map((s) => (
                  <Text key={s} style={styles.vat}>
                    {s}
                  </Text>
                ));
              })()}
              {company.vatMention ? <Text style={styles.vat}>{company.vatMention}</Text> : null}
              {invoice.subscriptionDateNotice ? (
                <Text style={[styles.vat, { marginTop: 6 }]}>{fillClauseVariables(invoice.subscriptionDateNotice, company)}</Text>
              ) : null}
            </>
          ) : invoice.mixedTotals ? (
            <>
              {invoice.mixedTotals.discountCents > 0 ? (
                <>
                  <Readable as="pair">
                  <View style={styles.totalLine}>
                    <Text style={styles.muted}>Prestations</Text>
                    <Text>{fmtMoney(invoice.mixedTotals.oneOffCents)}</Text>
                  </View>
                  </Readable>
                  <Readable as="pair">
                  <View style={styles.totalLine}>
                    <Text style={styles.muted}>
                      Remise
                      {invoice.discountType === "PERCENT"
                        ? ` (${((invoice.discountValue ?? 0) / 100).toFixed(2).replace(".", ",")} %)`
                        : ""}
                    </Text>
                    <Text>- {fmtMoney(invoice.mixedTotals.discountCents)}</Text>
                  </View>
                  </Readable>
                </>
              ) : null}
              <Readable as="mainPair">
              <View style={styles.grandTotal}>
                <Text style={styles.grandLabel}>Total du projet</Text>
                <Text style={styles.grandValue}>{fmtMoney(invoice.mixedTotals.projectCents)}</Text>
              </View>
              </Readable>
              <Text style={styles.vat}>Acompte et échéancier portent sur cette partie ponctuelle ; l'abonnement est facturé à part.</Text>
              <Readable as="pair">
              <View style={[styles.totalLine, { marginTop: 8 }]}>
                <Text style={{ fontFamily: "Helvetica-Bold" }}>
                  {invoice.mixedTotals.subscriptions.length > 1 ? "Abonnements" : "Abonnement"}
                </Text>
              </View>
              </Readable>
              {invoice.mixedTotals.subscriptions.map((s, i) => (
                <Text key={i} style={styles.vat}>
                  {invoice.mixedTotals!.subscriptions.length > 1 ? `${s.label} : ` : ""}
                  {s.text}
                </Text>
              ))}
              {invoice.mixedTotals.subscriptions.length > 1 ? (
                <Readable as="pair">
                <View style={styles.totalLine}>
                  <Text style={styles.muted}>Total des abonnements</Text>
                  <Text>
                    {[
                      invoice.mixedTotals.yearCents ? `${fmtMoney(invoice.mixedTotals.yearCents)} par an` : "",
                      invoice.mixedTotals.monthCents ? `${fmtMoney(invoice.mixedTotals.monthCents)} par mois` : "",
                    ]
                      .filter(Boolean)
                      .join(" + ")}
                  </Text>
                </View>
                </Readable>
              ) : null}
              {company.vatMention ? <Text style={styles.vat}>{company.vatMention}</Text> : null}
              {invoice.subscriptionDateNotice ? (
                <Text style={[styles.vat, { marginTop: 6 }]}>{fillClauseVariables(invoice.subscriptionDateNotice, company)}</Text>
              ) : null}
            </>
          ) : (
          <>
          {hasDiscount ? (
            <>
              <Readable as="pair">
              <View style={styles.totalLine}>
                <Text style={styles.muted}>Sous-total</Text>
                <Text>{fmtMoney(invoice.subtotalCents)}</Text>
              </View>
              </Readable>
              <Readable as="pair">
              <View style={styles.totalLine}>
                <Text style={styles.muted}>
                  {invoice.lines.some((l) => l.isSubscription) ? "Remise sur les prestations ponctuelles" : "Remise"}
                  {invoice.discountType === "PERCENT"
                    ? ` (${((invoice.discountValue ?? 0) / 100).toFixed(2).replace(".", ",")} %)`
                    : ""}
                </Text>
                <Text>- {fmtMoney(Math.max(0, invoice.subtotalCents - invoice.totalCents))}</Text>
              </View>
              </Readable>
            </>
          ) : null}
          <Readable as="mainPair">
          <View style={styles.grandTotal}>
            <Text style={styles.grandLabel}>{isCredit ? "Montant de l'avoir" : "Net à payer"}</Text>
            <Text style={styles.grandValue}>{fmtMoney(invoice.totalCents)}</Text>
          </View>
          </Readable>
          {company.vatMention ? <Text style={styles.vat}>{company.vatMention}</Text> : null}
          {invoice.subscriptionDateNotice ? (
            <Text style={[styles.vat, { marginTop: 6 }]}>{fillClauseVariables(invoice.subscriptionDateNotice, company)}</Text>
          ) : null}
          {showSettlement && !settled ? (
            <>
              {creditedCents > 0 ? (
                <Readable as="pair">
                <View style={styles.totalLine}>
                  <Text style={styles.muted}>Avoirs</Text>
                  <Text>- {fmtMoney(creditedCents)}</Text>
                </View>
                </Readable>
              ) : null}
              {paidCents > 0 ? (
                <Readable as="pair">
                <View style={styles.totalLine}>
                  <Text style={styles.muted}>Déjà réglé</Text>
                  <Text>- {fmtMoney(paidCents)}</Text>
                </View>
                </Readable>
              ) : null}
              <Readable as="pair">
              <View style={[styles.totalLine, { borderTopWidth: 1, borderColor: LINE }]}>
                <Text style={styles.strong}>Reste dû</Text>
                <Text style={styles.strong}>{fmtMoney(dueCents)}</Text>
              </View>
              </Readable>
            </>
          ) : null}
          {settled ? (
            <View style={styles.settled}>
              <Readable as="subheading">
              <Text style={styles.settledTitle}>FACTURE ACQUITTÉE</Text>
              </Readable>
              <Text style={{ fontSize: 8, color: "#14532d" }}>
                {lastPaidAt ? `Réglée le ${fmtDate(lastPaidAt)}. ` : ""}Ce document vaut reçu.
              </Text>
            </View>
          ) : null}
          </>
          )}
        </View>
        </Readable>

        {/* Devis récurrent : l'encadré ne porte que la clause (pack et facturation sont déjà dans le tableau et sous le
            total) ; sans clause, pas d'encadré. */}
        {invoice.lines.some((l) => l.isSubscription) && (!invoice.recurringSummary || recurringClauses.length > 0) ? (
          <Readable as="section" heading>
          <View style={[styles.box, styles.section]} wrap={false}>
            <Text style={styles.h2}>{subscriptionHeading(invoice.lines)}</Text>
            {invoice.recurringSummary ? (
              recurringClauses.map((c, i) => (
                <Text key={i} style={[styles.muted, { marginTop: i ? 4 : 2 }]}>
                  {c}
                </Text>
              ))
            ) : (
            <>
            {invoice.lines
              .filter((l) => l.isSubscription)
              .map((l, i) => (
                // Une seule chaîne : entre deux morceaux de texte, react-pdf perdait l'espace après « € ».
                <Text key={i} style={{ marginTop: 2 }}>
                  {`${l.description} : ${fmtMoney(l.unitPriceCents)} facturés automatiquement ${
                    l.billingInterval === "YEAR"
                      ? "chaque année à la date anniversaire"
                      : `chaque ${periodWord(l.billingInterval)}${l.billingDay ? ` le ${l.billingDay}` : ""}`
                  }. ${
                    l.startText
                      ? `Départ de la facturation : ${l.startText}.`
                      : invoice.recurringSummary
                        ? `Départ de la facturation : ${invoice.recurringSummary.startText}.`
                        : invoice.subscriptionOnly
                      ? "1re échéance facturée à partir de la signature, sans acompte."
                      : invoice.subscriptionFromDelivery
                        ? "1re échéance facturée à partir de la livraison, hors acompte et échéancier."
                        : "Le total de ce document inclut la 1re échéance ; les échéances suivantes feront l'objet de factures séparées."
                  }${l.commitmentMonths ? ` Engagement de ${l.commitmentMonths} mois à compter de la signature du devis.` : ""}`}
                </Text>
              ))}
            {(["MONTH", "QUARTER", "YEAR"] as const)
              .filter((iv) =>
                invoice.lines.some(
                  (l) => l.isSubscription && !l.commitmentMonths && (l.billingInterval === "YEAR" || l.billingInterval === "QUARTER" ? l.billingInterval : "MONTH") === iv,
                ),
              )
              .map((iv) =>
                invoice.subscriptionTerms?.[iv] ? (
                  <Text key={iv} style={[styles.muted, { marginTop: 4 }]}>
                    {fillClauseVariables(invoice.subscriptionTerms[iv]!, company, iv)}
                  </Text>
                ) : null,
              )}
            {invoice.subscriptionTerms?.COMMITMENT && invoice.lines.some((l) => l.isSubscription && l.commitmentMonths) ? (
              <Text style={[styles.muted, { marginTop: 4 }]}>{fillClauseVariables(invoice.subscriptionTerms.COMMITMENT, company, commitmentInterval(invoice.lines))}</Text>
            ) : null}
            </>
            )}
          </View>
          </Readable>
        ) : null}

        {isQuote && invoice.paymentPlanChoice && invoice.paymentPlanChoice.length > 0 ? (
          <Readable as="section" heading>
          <View style={styles.section} wrap={false}>
            <Text style={styles.h2}>{invoice.mixedTotals ? "Partie ponctuelle : échéancier au choix" : "Échéancier au choix"}</Text>
            <Text style={styles.muted}>La formule de paiement se choisit à la signature du devis.</Text>
            {invoice.paymentPlanChoice.map((p) => (
              <View key={p.title} style={{ marginTop: 6 }}>
                <Text style={styles.strong}>{p.title}</Text>
                {p.milestones.map((m, i) => (
                  <Readable key={i} as="item">
                  <View style={styles.milestone}>
                    <View style={{ flex: 1 }}>
                      <Text>
                        {m.label} ({(m.percentBps / 100).toFixed(0)} %)
                      </Text>
                      <Text style={styles.muted}>{m.triggerText}</Text>
                    </View>
                    <Text style={styles.strong}>{fmtMoney(m.amountCents)}</Text>
                  </View>
                  </Readable>
                ))}
              </View>
            ))}
          </View>
          </Readable>
        ) : isQuote && invoice.milestones && invoice.milestones.length > 0 ? (
          <Readable as="section" heading>
          <View style={styles.section} wrap={false}>
            <Text style={styles.h2}>
              {invoice.paymentPlanRetained
                ? `${invoice.mixedTotals ? "Partie ponctuelle, échéancier" : "Échéancier"} retenu par le client : ${invoice.paymentPlanRetained.toLowerCase()}`
                : invoice.mixedTotals
                  ? "Partie ponctuelle : échéancier de paiement"
                  : "Échéancier de paiement"}
            </Text>
            {invoice.milestones.map((m, i) => (
              <Readable key={i} as="item">
              <View style={styles.milestone}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.strong}>
                    {m.label} ({(m.percentBps / 100).toFixed(0)} %)
                  </Text>
                  <Text style={styles.muted}>
                    {m.triggerText}
                    {m.dueDate ? `, échéance ${fmtDate(m.dueDate)}` : ""}
                    {m.status ? ` (${m.status})` : ""}
                  </Text>
                </View>
                <Text style={styles.strong}>{fmtMoney(m.amountCents)}</Text>
              </View>
              </Readable>
            ))}
          </View>
          </Readable>
        ) : null}
    </>
  );
}

export function InvoiceDocument({ company, client, invoice, specimen, draft }: InvoicePdfData) {
  const { primary, secondary } = resolveBrandColors(company);
  const styles = createStyles(primary, secondary);

  const isCredit = invoice.documentType === "CREDIT_NOTE";
  const isQuote = invoice.documentType === "QUOTE";
  const isAcompte = invoice.invoiceType === "ACOMPTE";
  const isSolde = invoice.invoiceType === "SOLDE";
  const title = isCredit
    ? "AVOIR"
    : isQuote
      ? "DEVIS"
      : isAcompte
        ? "FACTURE D'ACOMPTE"
        : isSolde
          ? "FACTURE DE SOLDE"
          : "FACTURE";
  // Titre des métadonnées, annoncé par les lecteurs d'écran : casse normale, les capitales pouvant être épelées.
  const docTitle = title.charAt(0) + title.slice(1).toLowerCase();
  const brandName = company.tradeName ?? company.legalName;

  const legalFormLine = [
    company.legalName,
    company.legalForm ? company.legalForm : "Entrepreneur individuel",
    company.rcsMention,
  ]
    .filter(Boolean)
    .join(" - ");

  const meta: Array<[string, string]> = [["Date d'émission", fmtDate(invoice.issueDate)]];
  if (!isQuote && invoice.serviceDate) meta.push(["Date de la prestation", fmtDate(invoice.serviceDate)]);
  if (isQuote && invoice.validUntil) meta.push(["Valable jusqu'au", fmtDate(invoice.validUntil)]);
  if (!isQuote && invoice.dueDate) meta.push(["Échéance", fmtDate(invoice.dueDate)]);
  if (invoice.purchaseOrderRef) meta.push(["Bon de commande", invoice.purchaseOrderRef]);
  if (invoice.selectedProposal) meta.push(["Proposition retenue", invoice.selectedProposal]);
  if (invoice.quoteNumber) {
    meta.push([
      "Réf. devis",
      `${invoice.quoteNumber}${invoice.quoteIssueDate ? ` du ${fmtDate(invoice.quoteIssueDate)}` : ""}`,
    ]);
  }
  if (invoice.creditedInvoiceNumber) {
    meta.push([
      "Facture d'origine",
      `${invoice.creditedInvoiceNumber}${invoice.creditedInvoiceIssueDate ? ` du ${fmtDate(invoice.creditedInvoiceIssueDate)}` : ""}`,
    ]);
  }

  const { dueCents, showSettlement, settled } = settlementOf(invoice);

  // Aperçu avant émission : aucun numéro encore, jamais un blanc à sa place.
  const shownNumber = draft ? "APERÇU" : invoice.number;

  return (
    <Document title={`${docTitle} ${draft ? "(aperçu)" : shownNumber}`} author={brandName} creator={brandName} language="fr">
      <Page size="A4" style={styles.page}>
        <View style={styles.accent} fixed />
        {specimen || draft ? (
          <Text style={styles.specimen} fixed>
            {draft ? "APERÇU" : "EXEMPLE"}
          </Text>
        ) : null}

        <View style={styles.header}>
          <Readable as="issuer">
          <View style={{ flex: 1 }}>
            {company.brandLogoDataUrl ? (
              <Image src={company.brandLogoDataUrl} style={styles.logo} />
            ) : null}
            <Text style={styles.brand}>{brandName}</Text>
            <Text style={styles.muted}>{legalFormLine}</Text>
            <Text style={styles.muted}>
              {company.addressLine1}
              {company.addressLine2 ? `, ${company.addressLine2}` : ""}
            </Text>
            <Text style={styles.muted}>
              {company.postalCode} {company.city} - {company.country}
            </Text>
            <Text style={styles.muted}>
              SIRET {company.siret} · APE {company.apeCode}
            </Text>
            {company.vatIntraNumber ? (
              <Text style={styles.muted}>TVA intra : {company.vatIntraNumber}</Text>
            ) : null}
            {[company.email, company.phone, company.website].filter(Boolean).length > 0 ? (
              <Text style={styles.muted}>
                {[company.email, company.phone, company.website].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
          </View>
          </Readable>
          <View style={styles.docBlock}>
            <Readable as="heading">
            <Text style={styles.docKind}>{title}</Text>
            {draft ? (
              <>
                <Text style={styles.docNumber}>APERÇU</Text>
                <Text style={styles.muted}>Numéro attribué à l&apos;émission</Text>
              </>
            ) : (
              <Text style={styles.docNumber}>N° {invoice.number}</Text>
            )}
            </Readable>
            <View style={styles.docMeta}>
              {meta.map(([label, value]) => (
                <Readable key={label} as="detail">
                <View style={styles.metaRow}>
                  <Text style={styles.metaLabel}>{label}</Text>
                  <Text style={styles.metaValue}>{value}</Text>
                </View>
                </Readable>
              ))}
            </View>
          </View>
        </View>

        <View style={styles.parties}>
          <Readable as="recipient">
          <View style={styles.party}>
            <Text style={styles.partyTitle}>{isQuote ? "DESTINATAIRE" : "FACTURÉ À"}</Text>
            <Text style={styles.partyName}>{client.displayName}</Text>
            {client.addressLine1 ? <Text>{client.addressLine1}</Text> : null}
            {client.postalCode || client.city ? (
              <Text>{[client.postalCode, client.city].filter(Boolean).join(" ")}</Text>
            ) : null}
            {client.siret ? <Text style={styles.muted}>SIRET {client.siret}</Text> : null}
            {client.email ? <Text style={styles.muted}>{client.email}</Text> : null}
          </View>
          </Readable>
          {(isAcompte && invoice.milestoneTrigger) || invoice.paymentTerms || (isCredit && invoice.nothingToPay) ? (
            <Readable as="section" heading>
            <View style={styles.party}>
              <Text style={styles.partyTitle}>CONDITIONS</Text>
              {invoice.paymentTerms ? <Text>{invoice.paymentTerms}</Text> : null}
              {isAcompte && invoice.milestoneTriggerStep ? (
                <Text style={{ marginTop: 2 }}>
                  Déclencheur : étape « {invoice.milestoneTriggerStep.label} » validée
                  {invoice.milestoneTriggerStep.at ? ` le ${fmtDate(invoice.milestoneTriggerStep.at)}` : ""}
                </Text>
              ) : isAcompte && invoice.milestoneTrigger && invoice.milestoneTrigger !== invoice.paymentTerms ? (
                <Text style={{ marginTop: 2 }}>Déclencheur : {invoice.milestoneTrigger}</Text>
              ) : null}
              {isCredit && invoice.nothingToPay ? (
                <Text style={[styles.strong, { marginTop: 2 }]}>Vous n&apos;avez rien à payer.</Text>
              ) : null}
            </View>
            </Readable>
          ) : null}
        </View>

        {isSolde && invoice.balanceSummary ? (
          <Readable as="section" heading>
          <View style={[styles.box, { marginBottom: 16 }]}>
            <Text style={styles.h2}>Récapitulatif du marché</Text>
            <Readable as="pair">
            <View style={styles.totalLine}>
              <Text>Total du marché (devis {invoice.balanceSummary.quoteNumber ?? "?"})</Text>
              <Text>{fmtMoney(invoice.balanceSummary.marketTotalCents)}</Text>
            </View>
            </Readable>
            {invoice.balanceSummary.acomptes.map((a, i) => (
              <Readable key={i} as="pair">
              <View style={styles.totalLine}>
                <Text style={{ flex: 1, paddingRight: 10 }}>
                  {a.paid
                    ? `Acompte facturé et réglé (${a.number})`
                    : `Acompte facturé non réglé (${a.number}), à encaisser sur cette facture`}
                </Text>
                <Text>- {fmtMoney(a.amountCents)}</Text>
              </View>
              </Readable>
            ))}
            <Readable as="pair">
            <View style={[styles.totalLine, { borderTopWidth: 1, borderColor: LINE, marginTop: 4 }]}>
              <Text style={styles.strong}>Solde restant dû (cette facture)</Text>
              <Text style={styles.strong}>{fmtMoney(invoice.balanceSummary.balanceDueCents)}</Text>
            </View>
            </Readable>
          </View>
          </Readable>
        ) : null}

        {invoice.proposals?.length ? (
          <>
            <Text style={styles.proposalIntro}>
              {`Ce devis propose ${invoice.proposals.length} formules : choisissez-en une à la signature.`}
            </Text>
            {invoice.proposals.map((p, i) => (
              <Readable key={i} as="proposal">
              <View style={styles.proposal}>
                <Readable as="proposalHeading">
                <Text style={styles.proposalTitle} minPresenceAhead={120}>
                  {p.heading}
                </Text>
                </Readable>
                <DocumentBody company={company} invoice={p.invoice} styles={styles} />
              </View>
              </Readable>
            ))}
          </>
        ) : (
          <DocumentBody company={company} invoice={invoice} styles={styles} />
        )}

        {isQuote && invoice.acceptance?.mode ? (
          <Readable as="section" heading>
          <View style={styles.payBox} wrap={false}>
            <Text style={styles.h2}>Bon pour accord</Text>
            <View style={styles.signRow}>
              <View style={styles.signCol}>
                <Text style={styles.signName}>{invoice.acceptance.signerName}</Text>
                {invoice.acceptance.company ? (
                  <Text style={styles.muted}>pour {invoice.acceptance.company}</Text>
                ) : null}
                {invoice.acceptance.mode === "DRAWN" && invoice.acceptance.image ? (
                  <Image src={invoice.acceptance.image} style={styles.signImage} />
                ) : (
                  <Text style={styles.signTyped}>{invoice.acceptance.signerName}</Text>
                )}
                <Text style={styles.muted}>Signé le {fmtDateTime(invoice.acceptance.acceptedAt)}</Text>
              </View>
              <View style={styles.proof}>
                <Readable as="subheading">
                <Text style={styles.proofTitle}>SIGNATURE ÉLECTRONIQUE</Text>
                </Readable>
                <Text style={styles.muted}>Signé dans l'espace client {brandName}.</Text>
                {invoice.acceptance.emailMasked && invoice.acceptance.sessionLoginAt ? (
                  <Text style={styles.muted}>
                    Identité confirmée par la connexion à l'espace client le {fmtDateTime(invoice.acceptance.sessionLoginAt)} par
                    un code envoyé à {invoice.acceptance.emailMasked}.
                  </Text>
                ) : invoice.acceptance.emailMasked ? (
                  <Text style={styles.muted}>
                    Identité confirmée par un code à usage unique envoyé à {invoice.acceptance.emailMasked}.
                  </Text>
                ) : null}
                {invoice.acceptance.proofId ? (
                  <Text style={styles.muted}>Preuve n° {invoice.acceptance.proofId.slice(-10).toUpperCase()}</Text>
                ) : null}
                {invoice.acceptance.documentSha256 ? (
                  <Text style={styles.muted}>
                    Empreinte du devis accepté (SHA-256) : {shortHash(invoice.acceptance.documentSha256)}
                  </Text>
                ) : null}
                {invoice.acceptance.cgvAccepted && invoice.cgv ? (
                  <Text style={styles.muted}>CGV acceptées en ligne : version du {invoice.cgv.version}.</Text>
                ) : null}
                <SignatureTermsLines acceptance={invoice.acceptance} muted={styles.muted} />
              </View>
            </View>
          </View>
          </Readable>
        ) : isQuote && invoice.acceptance ? (
          <Readable as="section" heading>
          <View style={styles.payBox} wrap={false}>
            <Text style={styles.h2}>Bon pour accord</Text>
            <Text>
              Devis accepté par <Text style={styles.strong}>{invoice.acceptance.signerName}</Text> le{" "}
              {fmtDate(invoice.acceptance.acceptedAt)}.
            </Text>
            <SignatureTermsLines acceptance={invoice.acceptance} muted={styles.muted} />
          </View>
          </Readable>
        ) : null}

        {!isQuote && !isCredit && invoice.payments && invoice.payments.length > 0 ? (
          <Readable as="section" heading>
          <View style={styles.section} wrap={false}>
            <Text style={styles.h2}>Règlements reçus</Text>
            <Readable as="headRow">
            <View style={styles.th}>
              <Text style={styles.colPayDate}>DATE</Text>
              <Text style={styles.colPayMethod}>MOYEN</Text>
              <Text style={styles.colPayRef}>RÉFÉRENCE</Text>
              <Text style={styles.colPayAmount}>MONTANT</Text>
            </View>
            </Readable>
            {invoice.payments.map((p, i) => (
              <Readable key={i} as="row">
              <View style={styles.tr}>
                <Text style={styles.colPayDate}>{fmtDate(p.paidAt)}</Text>
                <Text style={styles.colPayMethod}>{p.method}</Text>
                <Text style={styles.colPayRef}>{p.reference ?? "-"}</Text>
                <Text style={styles.colPayAmount}>{fmtMoney(p.amountCents)}</Text>
              </View>
              </Readable>
            ))}
          </View>
          </Readable>
        ) : null}

        {invoice.notes ? (
          <Readable as="section" heading>
          <View style={styles.section}>
            <Text style={styles.h2}>Notes</Text>
            <Text>{invoice.notes}</Text>
          </View>
          </Readable>
        ) : null}

        {!isQuote && !isCredit && !settled && company.bankIban ? (
          <Readable as="section" heading>
          <View style={styles.payBox} wrap={false}>
            <Text style={styles.h2}>Règlement par virement</Text>
            <Text>
              {/* Virgule après le montant : react-pdf efface l'espace qui suit un Text imbriqué (« 1 800,00 €en »). */}
              Merci de régler <Text style={styles.strong}>{fmtMoney(showSettlement ? dueCents : invoice.totalCents)}</Text>, en indiquant
              la référence <Text style={styles.strong}>{draft ? "(numéro attribué à l'émission)" : invoice.number}</Text>.
            </Text>
            <View style={{ flexDirection: "row", gap: 24, marginTop: 6 }}>
              <View style={{ flex: 1 }}>
                {company.bankAccountHolder ? (
                  <Text style={styles.muted}>Titulaire : {company.bankAccountHolder}</Text>
                ) : null}
                {company.bankName ? <Text style={styles.muted}>Banque : {company.bankName}</Text> : null}
              </View>
              <View style={{ flex: 2 }}>
                <Text style={styles.strong}>IBAN {formatIban(company.bankIban)}</Text>
                {company.bankBic ? <Text style={styles.muted}>BIC {company.bankBic}</Text> : null}
              </View>
            </View>
          </View>
          </Readable>
        ) : null}

        {isQuote && invoice.withdrawalTerms ? (
          <Readable as="section" heading>
          <View style={styles.section} wrap={false}>
            <Text style={styles.h2}>Droit de rétractation</Text>
            {fillClauseVariables(invoice.withdrawalTerms, company)
              .split("\n")
              .map((p, i) => (
                <Text key={i} style={[styles.muted, { marginTop: i === 0 ? 0 : 4 }]}>
                  {p}
                </Text>
              ))}
          </View>
          </Readable>
        ) : null}

        <Readable as="section">
        <View style={styles.legal}>
          {isQuote && invoice.cgv ? (
            <Text>
              Conditions générales de vente applicables : version du {invoice.cgv.version}, {invoice.cgv.url}
            </Text>
          ) : null}
          <Text>
            {company.legalName}, {company.legalForm ?? "Entrepreneur individuel"}, SIREN{" "}
            {company.siren}, SIRET {company.siret}, code APE {company.apeCode}.
            {company.rcsMention ? ` ${company.rcsMention}.` : ""}
          </Text>
          <Text>
            Document émis dans le cadre de la micro-entreprise - activité libérale non
            réglementée (BNC).
          </Text>
          {!(invoice.legalClauses?.length) && company.vatMention ? (
            <Text>{company.vatMention}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && !isQuote && company.paymentConditions ? (
            <Text>Conditions de paiement : {company.paymentConditions}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && !isQuote && company.latePenaltiesText ? (
            <Text>{company.latePenaltiesText}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && !isQuote && company.earlyPaymentDiscountText ? (
            <Text>{company.earlyPaymentDiscountText}</Text>
          ) : null}
          {company.decennaleInsurer ? (
            <Text>
              Assurance décennale : {company.decennaleInsurer}
              {company.decennalePolicyNumber
                ? `, police n° ${company.decennalePolicyNumber}`
                : ""}
              {company.decennaleCoverageZone
                ? `, zone ${company.decennaleCoverageZone}`
                : ""}
              .
            </Text>
          ) : null}
          {(invoice.legalClauses ?? []).map((c, i) => (
            <Text key={i} style={{ marginTop: 4 }}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>{c.title} : </Text>
              {fillClauseVariables(c.body, company)}
            </Text>
          ))}
          {!(invoice.legalClauses?.length) && company.suspensionClause ? (
            <Text>{company.suspensionClause}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && company.legalMentions ? (
            <Text>{company.legalMentions}</Text>
          ) : null}
          {/* Médiation de la consommation : obligatoire envers les particuliers (L616-1). */}
          {client.type === "B2C" && company.mediationClause?.trim() ? (
            <Text style={{ marginTop: 4 }}>{company.mediationClause}</Text>
          ) : null}
          {company.pdfFooterText ? (
            <Text style={{ marginTop: 6 }}>{company.pdfFooterText}</Text>
          ) : null}
        </View>
        </Readable>

        {/* Pas de lineHeight sur la page : hérité, il masque le numéro de page (bug react-pdf). */}
        <View style={styles.footerRule} fixed />
        <Readable as="footer">
        <Text style={styles.footerLeft} fixed>
          {`${brandName} · ${title.charAt(0)}${title.slice(1).toLowerCase()} ${shownNumber}`}
        </Text>
        </Readable>
        <Text
          style={styles.footerRight}
          fixed
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`}
        />
      </Page>
    </Document>
  );
}
