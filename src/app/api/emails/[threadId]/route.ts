import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ threadId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { threadId } = await ctx.params;
  const thread = await prisma.emailThread.findUnique({
    where: { id: threadId },
    include: {
      client: { select: { id: true, displayName: true } },
      messages: { orderBy: { receivedAt: "asc" } },
    },
  });

  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    ...thread,
    participants: JSON.parse(thread.participants || "[]"),
    messages: thread.messages.map((m) => ({
      ...m,
      toAddresses: JSON.parse(m.toAddresses || "[]"),
    })),
  });
}
