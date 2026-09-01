import { describe, expect, it } from "vitest";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  PaymentMethod,
} from "@prisma/client";

describe("buildInvoicePdfPayload charte dynamique", () => {
  it("injecte statuts acomptes, règlements et mentions depuis les relations", () => {
    const issueDate = new Date("2026-03-01");
    const dueDate = new Date("2026-03-15");
    const paidAt = new Date("2026-03-10");

    const payload = buildInvoicePdfPayload({
      invoice: {
        id: "inv_1",
        number: "F-2026-0001",
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.PAID,
        clientId: "c1",
        subtotalCents: 100000,
        totalCents: 100000,
        issueDate,
        serviceDate: null,
        dueDate,
        validUntil: null,
        purchaseOrderRef: null,
        paymentTerms: null,
        notes: null,
        discountType: "NONE",
        discountValue: 0,
        quoteId: null,
        creditedInvoiceId: null,
        marketTotalCents: null,
        refundMethod: null,
        createdAt: issueDate,
        updatedAt: issueDate,
        quoteStatus: null,
        quoteDecidedAt: null,
        quoteSignerName: null,
        quoteRejectReason: null,
        clientSnapshot: null,
        lines: [
          {
            id: "l1",
            invoiceId: "inv_1",
            position: 1,
            description: "Prestation",
            quantity: 1,
            unitPriceCents: 100000,
            lineTotalCents: 100000,
            isSubscription: false,
            billingDay: null,
            serviceId: null,
            createdAt: issueDate,
            updatedAt: issueDate,
          },
        ],
        milestones: [
          {
            id: "m1",
            quoteId: "q1",
            position: 1,
            label: "Acompte",
            percentBps: 3000,
            amountCents: 30000,
            triggerText: "Signature",
            status: MilestoneStatus.PAID,
            dueDate,
            revolutOrderId: null,
            revolutPaymentId: null,
            checkoutUrl: null,
            paidAt,
            paymentMethod: PaymentMethod.CARD,
            manualReference: null,
            manualNotes: null,
            invoiceId: null,
            createdAt: issueDate,
            updatedAt: issueDate,
          },
        ],
        payments: [
          {
            id: "p1",
            invoiceId: "inv_1",
            amountCents: 100000,
            paidAt,
            method: PaymentMethod.CARD,
            reference: "pay_revolut",
            notes: null,
            createdAt: paidAt,
            updatedAt: paidAt,
          },
        ],
      },
      legalClauses: [],
    });

    expect(payload.milestones?.[0]?.status).toBe("Payé");
    expect(payload.milestones?.[0]?.dueDate).toEqual(dueDate);
    expect(payload.payments?.[0]?.method).toBe("Carte bancaire");
    expect(payload.payments?.[0]?.amountCents).toBe(100000);
  });
});
