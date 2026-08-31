import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { CompanySettings } from "@prisma/client";
import type { ClientSnapshot } from "@/lib/invoices/transitions";
import { centsToEuros } from "@/lib/money";

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 40,
    paddingHorizontal: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#0f172a",
  },
  header: {
    marginBottom: 22,
    paddingBottom: 14,
    borderBottomWidth: 2,
    borderBottomColor: "#4f46e5",
  },
  brand: { fontSize: 22, fontFamily: "Helvetica-Bold", color: "#4f46e5" },
  muted: { color: "#64748b", marginTop: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 24 },
  block: { flex: 1 },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 6, color: "#312e81" },
  table: { marginTop: 22, borderTopWidth: 1, borderColor: "#e2e8f0" },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#e2e8f0",
    paddingVertical: 7,
  },
  th: { fontFamily: "Helvetica-Bold", color: "#475569", backgroundColor: "#f8fafc" },
  colDesc: { flex: 3 },
  colQty: { flex: 1, textAlign: "right" },
  colPrice: { flex: 1.2, textAlign: "right" },
  colTotal: { flex: 1.2, textAlign: "right" },
  totals: { marginTop: 16, alignItems: "flex-end" },
  totalLine: { flexDirection: "row", justifyContent: "flex-end", gap: 24, marginTop: 4 },
  paymentBox: {
    marginTop: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: "#c7d2fe",
    backgroundColor: "#eef2ff",
    borderRadius: 4,
  },
  legal: {
    marginTop: 28,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: "#e2e8f0",
    fontSize: 8,
    color: "#64748b",
    lineHeight: 1.4,
  },
  badge: {
    marginTop: 4,
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: "#312e81",
  },
});

function formatIban(iban: string): string {
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  return clean.replace(/(.{4})/g, "$1 ").trim();
}

function fmtDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR").format(d);
}

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(centsToEuros(cents));
}

export type InvoicePdfData = {
  company: CompanySettings;
  client: ClientSnapshot;
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
    }>;
    lines: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      lineTotalCents: number;
      isSubscription?: boolean;
      billingDay?: number | null;
    }>;
    legalClauses?: Array<{ title: string; body: string }>;
  };
};

export function InvoiceDocument({ company, client, invoice }: InvoicePdfData) {
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

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>{company.tradeName ?? company.legalName}</Text>
          <Text>{company.legalName} - Entrepreneur individuel</Text>
          <Text style={styles.muted}>
            {company.addressLine1}
            {company.addressLine2 ? `, ${company.addressLine2}` : ""}
          </Text>
          <Text style={styles.muted}>
            {company.postalCode} {company.city} - {company.country}
          </Text>
          <Text style={styles.muted}>
            SIREN {company.siren} · SIRET {company.siret} · APE {company.apeCode}
          </Text>
          {company.website && <Text style={styles.muted}>{company.website}</Text>}
        </View>

        <View style={styles.row}>
          <View style={styles.block}>
            <Text style={styles.h2}>Client</Text>
            <Text>{client.displayName}</Text>
            {client.siret && <Text>SIRET {client.siret}</Text>}
            {client.addressLine1 && <Text>{client.addressLine1}</Text>}
            {(client.postalCode || client.city) && (
              <Text>
                {[client.postalCode, client.city].filter(Boolean).join(" ")}
              </Text>
            )}
            {client.email && <Text>{client.email}</Text>}
          </View>
          <View style={styles.block}>
            <Text style={styles.badge}>
              {title} n° {invoice.number}
            </Text>
            <Text>Date d&apos;émission : {fmtDate(invoice.issueDate)}</Text>
            {!isQuote && invoice.serviceDate ? (
              <Text>Date de la prestation : {fmtDate(invoice.serviceDate)}</Text>
            ) : null}
            {invoice.purchaseOrderRef ? (
              <Text>Bon de commande : {invoice.purchaseOrderRef}</Text>
            ) : null}
            {isQuote && invoice.validUntil ? (
              <Text>Valable jusqu&apos;au : {fmtDate(invoice.validUntil)}</Text>
            ) : null}
            {!isQuote && invoice.dueDate ? (
              <Text>Échéance : {fmtDate(invoice.dueDate)}</Text>
            ) : null}
            {invoice.creditedInvoiceNumber && (
              <Text>
                Réf. facture d&apos;origine : {invoice.creditedInvoiceNumber}
                {invoice.creditedInvoiceIssueDate
                  ? ` du ${fmtDate(invoice.creditedInvoiceIssueDate)}`
                  : ""}
              </Text>
            )}
            {isCredit && invoice.nothingToPay ? (
              <Text style={{ marginTop: 4, fontFamily: "Helvetica-Bold" }}>
                Vous n&apos;avez rien à payer.
              </Text>
            ) : null}
            {invoice.quoteNumber ? (
              <Text>
                Réf. devis : {invoice.quoteNumber}
                {invoice.quoteIssueDate
                  ? ` du ${fmtDate(invoice.quoteIssueDate)}`
                  : ""}
              </Text>
            ) : null}
            {isAcompte && invoice.milestoneTrigger ? (
              <Text>Déclencheur : {invoice.milestoneTrigger}</Text>
            ) : null}
            {invoice.paymentTerms && <Text>Conditions : {invoice.paymentTerms}</Text>}
          </View>
        </View>

        {isSolde && invoice.balanceSummary ? (
          <View style={{ marginTop: 16, padding: 10, borderWidth: 1, borderColor: "#cfdad3" }}>
            <Text style={styles.h2}>Récapitulatif du marché</Text>
            <Text style={{ marginTop: 4 }}>
              Total du marché (devis {invoice.balanceSummary.quoteNumber ?? "?"}) :{" "}
              {fmtMoney(invoice.balanceSummary.marketTotalCents)}
            </Text>
            {invoice.balanceSummary.acomptes.map((a, i) => (
              <Text key={i} style={{ marginTop: 3 }}>
                {a.paid
                  ? `Acompte facturé et réglé (${a.number}) : -${fmtMoney(a.amountCents)}`
                  : `Acompte facturé non réglé (${a.number}) : -${fmtMoney(a.amountCents)} (à encaisser sur cette facture)`}
              </Text>
            ))}
            <Text style={{ marginTop: 6, fontFamily: "Helvetica-Bold" }}>
              Solde restant dû (cette facture) :{" "}
              {fmtMoney(invoice.balanceSummary.balanceDueCents)}
            </Text>
          </View>
        ) : null}

        <View style={styles.table}>
          <View style={[styles.tr, styles.th]}>
            <Text style={styles.colDesc}>Description</Text>
            <Text style={styles.colQty}>Qté</Text>
            <Text style={styles.colPrice}>P.U.</Text>
            <Text style={styles.colTotal}>Total</Text>
          </View>
          {invoice.lines.map((line, i) => (
            <View key={i} style={styles.tr}>
              <View style={styles.colDesc}>
                <Text>{line.description}</Text>
                {line.isSubscription ? (
                  <Text style={{ marginTop: 2, fontSize: 8, color: "#5a6f65" }}>
                    Abonnement mensuel, facturé chaque mois
                    {line.billingDay ? ` le ${line.billingDay}` : ""}
                    {" : "}
                    {fmtMoney(line.unitPriceCents)} HT. Ce document inclut la 1re échéance.
                  </Text>
                ) : null}
              </View>
              <Text style={styles.colQty}>{line.quantity}</Text>
              <Text style={styles.colPrice}>{fmtMoney(line.unitPriceCents)}</Text>
              <Text style={styles.colTotal}>{fmtMoney(line.lineTotalCents)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          {invoice.discountType &&
          invoice.discountType !== "NONE" &&
          invoice.subtotalCents !== invoice.totalCents ? (
            <>
              <View style={styles.totalLine}>
                <Text>Sous-total HT</Text>
                <Text>{fmtMoney(invoice.subtotalCents)}</Text>
              </View>
              <View style={styles.totalLine}>
                <Text>
                  Remise
                  {invoice.discountType === "PERCENT"
                    ? ` (${((invoice.discountValue ?? 0) / 100).toFixed(2)} %)`
                    : ""}
                </Text>
                <Text>
                  −
                  {fmtMoney(
                    Math.max(0, invoice.subtotalCents - invoice.totalCents),
                  )}
                </Text>
              </View>
            </>
          ) : null}
          <View style={styles.totalLine}>
            <Text>Total TTC (= HT{company.vatMention ? ", franchise TVA" : ""})</Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{fmtMoney(invoice.totalCents)}</Text>
          </View>
        </View>

        {invoice.lines.some((l) => l.isSubscription) ? (
          <View
            style={{
              marginTop: 14,
              padding: 8,
              borderWidth: 1,
              borderColor: "#cfdad3",
              backgroundColor: "#f4f7f5",
            }}
          >
            <Text style={styles.h2}>Engagement d&apos;abonnement mensuel</Text>
            {invoice.lines
              .filter((l) => l.isSubscription)
              .map((l, i) => (
                <Text key={i} style={{ marginTop: 4, lineHeight: 1.4 }}>
                  {l.description} : {fmtMoney(l.unitPriceCents)} HT facturés automatiquement
                  chaque mois
                  {l.billingDay ? ` le ${l.billingDay}` : ""}
                  . Le total de ce document inclut la 1re échéance ; les échéances suivantes
                  feront l&apos;objet de factures séparées.
                </Text>
              ))}
          </View>
        ) : null}

        {isQuote && invoice.milestones && invoice.milestones.length > 0 ? (
          <View style={{ marginTop: 20 }}>
            <Text style={styles.h2}>Échéancier de paiement</Text>
            {invoice.milestones.map((m, i) => (
              <Text key={i} style={{ marginTop: 3 }}>
                {m.label} ({(m.percentBps / 100).toFixed(0)} %) : {fmtMoney(m.amountCents)} -{" "}
                {m.triggerText}
              </Text>
            ))}
          </View>
        ) : null}

        {invoice.notes && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.h2}>Notes</Text>
            <Text>{invoice.notes}</Text>
          </View>
        )}

        {!isQuote && !isCredit && company.bankIban ? (
          <View style={styles.paymentBox}>
            <Text style={styles.h2}>Réglement par virement</Text>
            <Text style={{ marginTop: 4 }}>
              Merci de régler {fmtMoney(invoice.totalCents)} par virement en indiquant la référence{" "}
              <Text style={{ fontFamily: "Helvetica-Bold" }}>{invoice.number}</Text>.
            </Text>
            {company.bankAccountHolder ? (
              <Text style={{ marginTop: 6 }}>Titulaire : {company.bankAccountHolder}</Text>
            ) : null}
            {company.bankName ? <Text>Banque : {company.bankName}</Text> : null}
            <Text style={{ marginTop: 4, fontFamily: "Helvetica-Bold" }}>
              IBAN : {formatIban(company.bankIban)}
            </Text>
            {company.bankBic ? <Text>BIC : {company.bankBic}</Text> : null}
          </View>
        ) : null}

        <View style={styles.legal}>
          <Text>
            {company.legalName}, Entrepreneur individuel, SIREN {company.siren}, SIRET{" "}
            {company.siret}, code APE {company.apeCode}.
          </Text>
          <Text>
            Document émis dans le cadre de la micro-entreprise - activité libérale non réglementée
            (BNC).
          </Text>
          {/* Mentions imposées par la loi : affichées quoi qu'il arrive, les
              clauses personnalisées viennent s'y ajouter et non s'y substituer. */}
          {company.vatMention ? <Text>{company.vatMention}</Text> : null}
          {!isQuote && company.paymentConditions ? (
            <Text>Conditions de paiement : {company.paymentConditions}</Text>
          ) : null}
          {!isQuote && company.latePenaltiesText ? (
            <Text>{company.latePenaltiesText}</Text>
          ) : null}
          {!isQuote && company.earlyPaymentDiscountText ? (
            <Text>{company.earlyPaymentDiscountText}</Text>
          ) : null}
          {(invoice.legalClauses ?? []).map((c, i) => (
              <Text key={i} style={{ marginTop: 4 }}>
                {c.title} : {c.body}
              </Text>
            ))}
          {!(invoice.legalClauses?.length) && company.suspensionClause ? (
            <Text>{company.suspensionClause}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && company.legalMentions ? (
            <Text>{company.legalMentions}</Text>
          ) : null}
          {company.b2cActivity && company.mediationClause ? (
            <Text style={{ marginTop: 4 }}>{company.mediationClause}</Text>
          ) : null}
        </View>
      </Page>
    </Document>
  );
}
