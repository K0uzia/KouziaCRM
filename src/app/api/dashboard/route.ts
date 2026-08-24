import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDashboardSnapshot } from "@/lib/finance/dashboard-service";
import { isCashflowScope } from "@/lib/finance/cashflow-service";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawScope = req.nextUrl.searchParams.get("scope") ?? "month";
  const scope = isCashflowScope(rawScope) ? rawScope : "month";
  const invoiceId = req.nextUrl.searchParams.get("invoiceId");

  return NextResponse.json(
    await getDashboardSnapshot(scope, invoiceId && invoiceId.length > 0 ? invoiceId : null),
  );
}
