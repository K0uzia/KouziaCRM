import { NextResponse } from "next/server";
import { InvoiceStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { renderInvoicePdf } from "@/lib/pdf/render";
import { decryptOptional } from "@/lib/crypto";
import type { ClientSnapshot } from "@/lib/invoices/transitions";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { position: "asc" } },
      client: true,
      creditedInvoice: true,
    },
  });
  if (!invoice) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  if (invoice.status === InvoiceStatus.DRAFT || !invoice.number) {
    return NextResponse.json({ error: "PDF disponible uniquement après émission" }, { status: 400 });
  }

  const company = await getCompanySettings();
  const snapshot =
    (invoice.clientSnapshot as ClientSnapshot | null) ??
    ({
      displayName: invoice.client.displayName,
      type: invoice.client.type,
      email: decryptOptional(invoice.client.emailEncrypted),
      phone: decryptOptional(invoice.client.phoneEncrypted),
      siret: decryptOptional(invoice.client.siretEncrypted),
      addressLine1: invoice.client.addressLine1,
      addressLine2: invoice.client.addressLine2,
      postalCode: invoice.client.postalCode,
      city: invoice.client.city,
      country: invoice.client.country,
    } satisfies ClientSnapshot);

  const buffer = await renderInvoicePdf({
    company,
    invoice: {
      number: invoice.number,
      documentType: invoice.documentType,
      issueDate: invoice.issueDate!,
      dueDate: invoice.dueDate,
      paymentTerms: invoice.paymentTerms,
      notes: invoice.notes,
      totalCents: invoice.totalCents,
      subtotalCents: invoice.subtotalCents,
      creditedInvoiceNumber: invoice.creditedInvoice?.number ?? null,
      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        lineTotalCents: l.lineTotalCents,
      })),
    },
    client: snapshot,
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoice.number}.pdf"`,
    },
  });
}
