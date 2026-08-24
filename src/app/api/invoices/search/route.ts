import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Recherche factures encaissées (simulation tunnel).
 * GET /api/invoices/search?q=2026-004
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json([]);

  const invoices = await prisma.invoice.findMany({
    where: {
      documentType: "INVOICE",
      payments: { some: {} },
      OR: [
        { number: { contains: q } },
        { client: { displayName: { contains: q } } },
      ],
    },
    include: {
      payments: { select: { amountCents: true } },
      client: { select: { displayName: true } },
    },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    take: 12,
  });

  return NextResponse.json(
    invoices.map((inv) => ({
      id: inv.id,
      number: inv.number,
      displayName: inv.client.displayName,
      paidCents: inv.payments.reduce((s, p) => s + p.amountCents, 0),
    })),
  );
}
