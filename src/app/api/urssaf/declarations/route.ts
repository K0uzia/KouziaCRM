import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await prisma.urssafDeclaration.findMany({
    orderBy: { periodStart: "desc" },
    take: 50,
  });
  return NextResponse.json(rows);
}
