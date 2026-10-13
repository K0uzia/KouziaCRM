import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { formatEUR } from "@/lib/money.js";

/** Reçu d'un règlement : pièce remise au client, distincte de la facture (qui reste telle qu'émise). */

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 9.5, fontFamily: "Helvetica", color: "#1f2433", lineHeight: 1.4 },
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 24,
    paddingBottom: 12,
    marginBottom: 18,
    borderBottomWidth: 2,
    borderBottomColor: "#fe9a00",
  },
  brand: { fontSize: 15, fontFamily: "Helvetica-Bold", color: "#0b1020" },
  muted: { color: "#5b6478" },
  title: { fontSize: 15, fontFamily: "Helvetica-Bold", textAlign: "right" },
  section: { marginBottom: 14 },
  label: { fontSize: 7.5, textTransform: "uppercase", color: "#5b6478", marginBottom: 3 },
  strong: { fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#e3e6ee" },
  amount: { fontSize: 18, fontFamily: "Helvetica-Bold", marginTop: 2 },
  settled: {
    marginTop: 10,
    padding: 8,
    borderWidth: 1.5,
    borderColor: "#15803d",
    color: "#15803d",
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
  },
  legal: { marginTop: 24, fontSize: 7.5, color: "#5b6478" },
});

export type PaymentReceiptPdfData = {
  company: {
    legalName: string;
    tradeName: string | null;
    siret: string;
    addressLine1: string;
    postalCode: string;
    city: string;
    email: string | null;
    vatMention: string | null;
  };
  client: { displayName: string; addressLine1: string | null; postalCode: string | null; city: string | null };
  payment: { paidAt: Date; amountCents: number; methodLabel: string; reference: string | null };
  invoice: { number: string; issueDate: Date | null; totalCents: number; label: string };
  /** Réglé à la date de ce reçu (ce règlement compris) et reste dû. */
  paidToDateCents: number;
  remainingCents: number;
  issuedAt: Date;
};

const fmtDate = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris" }).format(d);

export function PaymentReceiptDocument(data: PaymentReceiptPdfData) {
  const { company, client, payment, invoice } = data;
  const brand = company.tradeName || company.legalName;
  return (
    <Document title={`Reçu de paiement ${invoice.number}`} author={company.legalName} language="fr">
      <Page size="A4" style={styles.page}>
        <View style={styles.head}>
          <View>
            <Text style={styles.brand}>{brand}</Text>
            <Text style={styles.muted}>{company.legalName}</Text>
            <Text style={styles.muted}>
              {company.addressLine1}, {company.postalCode} {company.city}
            </Text>
            <Text style={styles.muted}>SIRET {company.siret}</Text>
            {company.email ? <Text style={styles.muted}>{company.email}</Text> : null}
          </View>
          <View>
            <Text style={styles.title}>Reçu de paiement</Text>
            <Text style={[styles.muted, { textAlign: "right" }]}>
              Règlement du {fmtDate(payment.paidAt)} sur {invoice.number}
            </Text>
            <Text style={[styles.muted, { textAlign: "right" }]}>Émis le {fmtDate(data.issuedAt)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Reçu de</Text>
          <Text style={styles.strong}>{client.displayName}</Text>
          {client.addressLine1 ? <Text>{client.addressLine1}</Text> : null}
          {client.postalCode || client.city ? (
            <Text>{[client.postalCode, client.city].filter(Boolean).join(" ")}</Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Montant reçu</Text>
          <Text style={styles.amount}>{formatEUR(payment.amountCents)}</Text>
          <Text>
            le {fmtDate(payment.paidAt)}, par {payment.methodLabel}
            {payment.reference ? ` (réf. ${payment.reference})` : ""}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Facture concernée</Text>
          <View style={styles.row}>
            <Text>
              {invoice.label} {invoice.number}
              {invoice.issueDate ? ` du ${fmtDate(invoice.issueDate)}` : ""}
            </Text>
            <Text style={styles.strong}>{formatEUR(invoice.totalCents)}</Text>
          </View>
          <View style={styles.row}>
            <Text>Réglé à ce jour (ce paiement compris)</Text>
            <Text>{formatEUR(data.paidToDateCents)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.strong}>Reste dû</Text>
            <Text style={styles.strong}>{formatEUR(data.remainingCents)}</Text>
          </View>
          {data.remainingCents === 0 ? <Text style={styles.settled}>FACTURE ACQUITTÉE</Text> : null}
        </View>

        <Text style={styles.legal}>
          Ce reçu atteste du paiement indiqué ci-dessus. Il ne remplace pas la facture, qui reste la pièce de référence.
          {company.vatMention ? ` ${company.vatMention}.` : ""}
        </Text>
      </Page>
    </Document>
  );
}
