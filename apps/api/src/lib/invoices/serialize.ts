import type { Invoice, InvoiceLine, Payment, Client } from "@prisma/client";
import { Prisma } from "@prisma/client";

function qty(value: Prisma.Decimal | number | string): number {
  return Number(value);
}

export function serializeInvoiceLine(line: InvoiceLine) {
  return {
    ...line,
    quantity: qty(line.quantity),
  };
}

export function serializeInvoice<
  T extends Invoice & {
    lines?: InvoiceLine[];
    payments?: Pick<Payment, "id" | "amountCents" | "paidAt" | "method">[];
    client?: Pick<Client, "id" | "displayName" | "clientNumber"> | Client | null;
  },
>(invoice: T) {
  return {
    ...invoice,
    lines: invoice.lines?.map(serializeInvoiceLine),
    quantity: undefined,
  };
}
