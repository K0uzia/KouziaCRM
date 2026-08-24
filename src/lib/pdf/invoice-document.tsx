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
    documentType: "INVOICE" | "CREDIT_NOTE";
    issueDate: Date;
    dueDate: Date | null;
    paymentTerms: string | null;
    notes: string | null;
    subtotalCents: number;
    totalCents: number;
    creditedInvoiceNumber: string | null;
    lines: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      lineTotalCents: number;
    }>;
  };
};

export function InvoiceDocument({ company, client, invoice }: InvoicePdfData) {
  const isCredit = invoice.documentType === "CREDIT_NOTE";
  const title = isCredit ? "AVOIR" : "FACTURE";

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>{company.tradeName ?? company.legalName}</Text>
          <Text>{company.legalName} — Entrepreneur individuel</Text>
          <Text style={styles.muted}>
            {company.addressLine1}
            {company.addressLine2 ? `, ${company.addressLine2}` : ""}
          </Text>
          <Text style={styles.muted}>
            {company.postalCode} {company.city} — {company.country}
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
            {invoice.dueDate && <Text>Échéance : {fmtDate(invoice.dueDate)}</Text>}
            {invoice.creditedInvoiceNumber && (
              <Text>Réf. facture d&apos;origine : {invoice.creditedInvoiceNumber}</Text>
            )}
            {invoice.paymentTerms && <Text>Conditions : {invoice.paymentTerms}</Text>}
          </View>
        </View>

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

        {invoice.notes && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.h2}>Notes</Text>
            <Text>{invoice.notes}</Text>
          </View>
        )}

        <View style={styles.legal}>
          <Text>{company.vatMention}</Text>
          <Text>
            {company.legalName}, Entrepreneur individuel, SIREN {company.siren}, SIRET{" "}
            {company.siret}, code APE {company.apeCode}.
          </Text>
          <Text>
            Document émis dans le cadre de la micro-entreprise — activité libérale non réglementée
            (BNC).
          </Text>
        </View>
      </Page>
    </Document>
  );
}
