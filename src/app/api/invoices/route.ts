import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeLineTotals } from "@/lib/invoices/totals";
import { eurosToCents } from "@/lib/money";

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPriceEuros: z.coerce.number(),
});

const createSchema = z.object({
  clientId: z.string().min(1),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const invoices = await prisma.invoice.findMany({
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    include: {
      client: { select: { id: true, displayName: true } },
      payments: true,
    },
  });
  return NextResponse.json(invoices);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const client = await prisma.client.findUnique({ where: { id: parsed.data.clientId } });
  if (!client) {
    return NextResponse.json({ error: "Client introuvable" }, { status: 404 });
  }

  const { lines, subtotalCents, totalCents } = computeLineTotals(
    parsed.data.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: eurosToCents(l.unitPriceEuros),
    })),
  );

  const invoice = await prisma.invoice.create({
    data: {
      clientId: parsed.data.clientId,
      notes: parsed.data.notes ?? null,
      paymentTerms: parsed.data.paymentTerms ?? "Paiement à réception",
      subtotalCents,
      totalCents,
      lines: {
        create: lines,
      },
    },
    include: { lines: true, client: true },
  });

  return NextResponse.json(invoice, { status: 201 });
}
