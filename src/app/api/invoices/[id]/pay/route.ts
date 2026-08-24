import { NextResponse } from "next/server";
import { z } from "zod";
import { InvoiceStatus, PaymentMethod } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { eurosToCents } from "@/lib/money";

type Params = { params: Promise<{ id: string }> };

const paySchema = z.object({
  amountEuros: z.coerce.number().positive(),
  paidAt: z.string().optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const parsed = paySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { payments: true },
  });
  if (!invoice) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  if (invoice.status !== InvoiceStatus.ISSUED && invoice.status !== InvoiceStatus.PAID) {
    return NextResponse.json({ error: "Paiement possible uniquement sur facture émise" }, { status: 400 });
  }
  if (invoice.totalCents < 0) {
    return NextResponse.json({ error: "Pas de paiement sur un avoir" }, { status: 400 });
  }

  const amountCents = eurosToCents(parsed.data.amountEuros);
  const paidSoFar = invoice.payments.reduce((s, p) => s + p.amountCents, 0);

  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.payment.create({
      data: {
        invoiceId: id,
        amountCents,
        paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date(),
        method: parsed.data.method ?? PaymentMethod.BANK_TRANSFER,
        reference: parsed.data.reference ?? null,
        notes: parsed.data.notes ?? null,
      },
    });

    const newTotal = paidSoFar + amountCents;
    if (newTotal >= invoice.totalCents) {
      await tx.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.PAID },
      });
    }

    return created;
  });

  return NextResponse.json(payment, { status: 201 });
}
