import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { issueInvoice } from "@/lib/invoices/transitions";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;

  let issueDate = new Date();
  let dueDate: Date | undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      issueDate?: string;
      dueDate?: string;
    };
    if (body.issueDate) issueDate = new Date(body.issueDate);
    if (body.dueDate) dueDate = new Date(body.dueDate);
  }

  try {
    const invoice = await issueInvoice(id, issueDate, dueDate);
    return NextResponse.json(invoice);
  } catch (e) {
    console.error("[issue]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Erreur d'émission" },
      { status: 400 },
    );
  }
}
