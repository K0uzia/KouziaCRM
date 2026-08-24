import { NextResponse } from "next/server";
import { z } from "zod";
import { InvoiceStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeLineTotals } from "@/lib/invoices/totals";
import { eurosToCents } from "@/lib/money";

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  clientId: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.coerce.number().positive(),
        unitPriceEuros: z.coerce.number(),
      }),
    )
    .min(1)
    .optional(),
});

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { position: "asc" } },
      client: true,
      payments: { orderBy: { paidAt: "desc" } },
      creditedInvoice: true,
      creditNotes: true,
    },
  });
  if (!invoice) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  return NextResponse.json(invoice);
}

export async function PUT(request: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.invoice.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  if (existing.status !== InvoiceStatus.DRAFT) {
    return NextResponse.json({ error: "Seuls les brouillons sont modifiables" }, { status: 400 });
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data: {
    clientId?: string;
    notes?: string | null;
    paymentTerms?: string | null;
    subtotalCents?: number;
    totalCents?: number;
  } = {};

  if (parsed.data.clientId) data.clientId = parsed.data.clientId;
  if (parsed.data.notes !== undefined) data.notes = parsed.data.notes;
  if (parsed.data.paymentTerms !== undefined) data.paymentTerms = parsed.data.paymentTerms;

  if (parsed.data.lines) {
    const computed = computeLineTotals(
      parsed.data.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: eurosToCents(l.unitPriceEuros),
      })),
    );
    data.subtotalCents = computed.subtotalCents;
    data.totalCents = computed.totalCents;

    await prisma.$transaction([
      prisma.invoiceLine.deleteMany({ where: { invoiceId: id } }),
      prisma.invoice.update({
        where: { id },
        data: {
          ...data,
          lines: { create: computed.lines },
        },
      }),
    ]);
  } else {
    await prisma.invoice.update({ where: { id }, data });
  }

  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id },
    include: { lines: true, client: true },
  });
  return NextResponse.json(invoice);
}

export async function DELETE() {
  return NextResponse.json(
    { error: "Suppression interdite — annulez via un avoir" },
    { status: 405 },
  );
}
