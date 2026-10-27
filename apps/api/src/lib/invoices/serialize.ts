import type { Invoice, InvoiceLine, Payment, Client } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { readClientSnapshot } from "@/lib/invoices/client-snapshot.js";

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
  // Copie du client chiffrée au repos : l'API la rend lisible, comme avant, sans le texte chiffré.
  const { clientSnapshotEncrypted: _sealed, ...rest } = invoice;
  return {
    ...rest,
    clientSnapshot: readClientSnapshot(invoice) as Prisma.JsonValue,
    lines: invoice.lines?.map(serializeInvoiceLine),
    quantity: undefined,
  };
}
