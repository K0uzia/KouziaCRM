import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { CompanySettings } from "@prisma/client";
import type { ClientSnapshot } from "@/lib/invoices/transitions";
import { centsToEuros } from "@/lib/money";

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#14201b",
  },
  header: { marginBottom: 24 },
  brand: { fontSize: 20, fontFamily: "Helvetica-Bold", color: "#1f5c45" },
  muted: { color: "#5a6f65", marginTop: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 24 },
  block: { flex: 1 },
  h2: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  table: { marginTop: 24, borderTopWidth: 1, borderColor: "#cfdad3" },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#cfdad3",
    paddingVertical: 6,
  },
  th: { fontFamily: "Helvetica-Bold" },
  colDesc: { flex: 3 },
  colQty: { flex: 1, textAlign: "right" },
  colPrice: { flex: 1.2, textAlign: "right" },
  colTotal: { flex: 1.2, textAlign: "right" },
  totals: { marginTop: 16, alignItems: "flex-end" },
  totalLine: { flexDirection: "row", justifyContent: "flex-end", gap: 24, marginTop: 4 },
  legal: {
    marginTop: 28,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: "#cfdad3",
    fontSize: 8,
    color: "#5a6f65",
    lineHeight: 1.4,
  },
  badge: {
    marginTop: 8,
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
  },
});

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
    dueDate: Date | null;
    validUntil?: Date | null;
    paymentTerms: string | null;
    notes: string | null;
    subtotalCents: number;
    totalCents: number;
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
              <Text style={styles.colDesc}>{line.description}</Text>
              <Text style={styles.colQty}>{line.quantity}</Text>
              <Text style={styles.colPrice}>{fmtMoney(line.unitPriceCents)}</Text>
              <Text style={styles.colTotal}>{fmtMoney(line.lineTotalCents)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text>Total TTC (= HT, franchise TVA)</Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{fmtMoney(invoice.totalCents)}</Text>
          </View>
        </View>

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

        <View style={styles.legal}>
          <Text>
            {company.legalName}, Entrepreneur individuel, SIREN {company.siren}, SIRET{" "}
            {company.siret}, code APE {company.apeCode}.
          </Text>
          <Text>
            Document émis dans le cadre de la micro-entreprise - activité libérale non réglementée
            (BNC).
          </Text>
          {(invoice.legalClauses ?? []).map((c, i) => (
              <Text key={i} style={{ marginTop: 4 }}>
                {c.title} : {c.body}
              </Text>
            ))}
          {!(invoice.legalClauses?.length) && company.vatMention ? (
            <Text>{company.vatMention}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && company.paymentConditions ? (
            <Text>Conditions de paiement : {company.paymentConditions}</Text>
          ) : null}
          {!(invoice.legalClauses?.length) && company.latePenaltiesText ? (
            <Text>{company.latePenaltiesText}</Text>
          ) : null}
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
