import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cancelInvoiceWithCreditNote } from "@/lib/invoices/transitions";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();

  try {
    const creditNote = await cancelInvoiceWithCreditNote(id, issueDate);
    return NextResponse.json(creditNote, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Erreur d'annulation" },
      { status: 400 },
    );
  }
}
