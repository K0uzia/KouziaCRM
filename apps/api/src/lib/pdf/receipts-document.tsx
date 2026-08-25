import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { centsToEuros } from "@/lib/money";

const styles = StyleSheet.create({
  page: {
    padding: 28,
    fontSize: 8,
    fontFamily: "Helvetica",
    color: "#14201b",
  },
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 24,
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: "#0f766e",
  },
  brand: { fontSize: 14, fontFamily: "Helvetica-Bold", color: "#0f766e" },
  muted: { color: "#5a6f65", marginTop: 2, fontSize: 8 },
  title: { fontSize: 12, fontFamily: "Helvetica-Bold", textAlign: "right" },
  table: { marginTop: 4 },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#cfdad3",
    paddingVertical: 4,
    paddingHorizontal: 2,
    alignItems: "flex-start",
  },
  th: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    textTransform: "uppercase",
    color: "#5a6f65",
    backgroundColor: "#f0f7f5",
    paddingVertical: 5,
  },
  colDate: { width: "9%" },
  colInvoice: { width: "12%" },
  colCode: { width: "10%" },
  colClient: { width: "16%" },
  colNature: { width: "28%" },
  colMethod: { width: "12%" },
  colAmount: { width: "13%", textAlign: "right" },
  foot: {
    marginTop: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  total: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  legal: {
    marginTop: 12,
    fontSize: 7,
    color: "#5a6f65",
    lineHeight: 1.4,
  },
});

function fmtDate(iso: string) {
  return new Intl.DateTimeFormat("fr-FR").format(new Date(iso));
}

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(centsToEuros(cents));
}

export type ReceiptsPdfRow = {
  paidAt: string;
  invoiceNumber: string | null;
  clientNumber: string | null;
  clientName: string;
  nature: string;
  paymentMethodLabel: string;
  amountCents: number;
};

export type ReceiptsPdfData = {
  year: number;
  editedAt: Date;
  company: {
    legalName: string;
    tradeName: string | null;
    siret: string;
    addressLine1: string;
    postalCode: string;
    city: string;
  };
  rows: ReceiptsPdfRow[];
  totalCents: number;
};

export function ReceiptsDocument(data: ReceiptsPdfData) {
  const brand = data.company.tradeName ?? data.company.legalName;
  return (
    <Document title={`Livre des recettes ${data.year}`}>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.head}>
          <View>
            <Text style={styles.brand}>{brand}</Text>
            <Text style={styles.muted}>{data.company.legalName}</Text>
            <Text style={styles.muted}>
              {data.company.addressLine1}, {data.company.postalCode}{" "}
              {data.company.city}
            </Text>
            <Text style={styles.muted}>SIRET {data.company.siret}</Text>
          </View>
          <View>
            <Text style={styles.title}>Livre des recettes {data.year}</Text>
            <Text style={[styles.muted, { textAlign: "right" }]}>
              Micro-entreprise · encaissements
            </Text>
            <Text style={[styles.muted, { textAlign: "right" }]}>
              Édité le {fmtDate(data.editedAt.toISOString())}
            </Text>
          </View>
        </View>

        <View style={styles.table}>
          <View style={[styles.tr, styles.th]}>
            <Text style={styles.colDate}>Date</Text>
            <Text style={styles.colInvoice}>Facture</Text>
            <Text style={styles.colCode}>Code client</Text>
            <Text style={styles.colClient}>Client</Text>
            <Text style={styles.colNature}>Nature</Text>
            <Text style={styles.colMethod}>Règlement</Text>
            <Text style={styles.colAmount}>Montant</Text>
          </View>
          {data.rows.map((r, i) => (
            <View key={`${r.invoiceNumber ?? "x"}-${i}`} style={styles.tr} wrap={false}>
              <Text style={styles.colDate}>{fmtDate(r.paidAt)}</Text>
              <Text style={styles.colInvoice}>{r.invoiceNumber ?? ""}</Text>
              <Text style={styles.colCode}>{r.clientNumber ?? ""}</Text>
              <Text style={styles.colClient}>{r.clientName}</Text>
              <Text style={styles.colNature}>{r.nature}</Text>
              <Text style={styles.colMethod}>{r.paymentMethodLabel}</Text>
              <Text style={styles.colAmount}>{fmtMoney(r.amountCents)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.foot}>
          <Text style={styles.muted}>{data.rows.length} encaissement(s)</Text>
          <Text style={styles.total}>Total : {fmtMoney(data.totalCents)}</Text>
        </View>

        <Text style={styles.legal}>
          Registre chronologique des recettes (micro-entreprise). Montants TTC =
          HT (franchise en base de TVA, art. 293 B du CGI). Conservez ce document
          avec vos justificatifs pour le contrôle fiscal.
        </Text>
      </Page>
    </Document>
  );
}
