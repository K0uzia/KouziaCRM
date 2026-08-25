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

export function serializeInvoice(
  invoice: Invoice & {
    lines?: InvoiceLine[];
    payments?: Payment[];
    client?: Pick<Client, "id" | "displayName" | "clientNumber"> | Client | null;
  },
) {
  return {
    ...invoice,
    lines: invoice.lines?.map(serializeInvoiceLine),
    quantity: undefined,
  };
}
