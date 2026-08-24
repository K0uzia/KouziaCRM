import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { clientInputSchema, serializeClient, toPrismaClientData } from "@/lib/clients";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  return NextResponse.json(serializeClient(client));
}

export async function PUT(request: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const parsed = clientInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const client = await prisma.client.update({
    where: { id },
    data: toPrismaClientData(parsed.data),
  });
  return NextResponse.json(serializeClient(client));
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const invoices = await prisma.invoice.count({ where: { clientId: id } });
  if (invoices > 0) {
    return NextResponse.json(
      { error: "Impossible de supprimer un client avec des factures" },
      { status: 400 },
    );
  }

  await prisma.client.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
