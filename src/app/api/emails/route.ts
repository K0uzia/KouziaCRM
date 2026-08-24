import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const threads = await prisma.emailThread.findMany({
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    include: {
      client: { select: { id: true, displayName: true } },
      messages: {
        orderBy: { receivedAt: "desc" },
        take: 1,
        select: {
          id: true,
          fromAddress: true,
          subject: true,
          bodyText: true,
          receivedAt: true,
          direction: true,
        },
      },
    },
  });

  return NextResponse.json(
    threads.map((t) => ({
      id: t.id,
      subject: t.subject,
      lastMessageAt: t.lastMessageAt,
      client: t.client,
      preview: t.messages[0]?.bodyText?.slice(0, 140) ?? "",
      lastFrom: t.messages[0]?.fromAddress ?? "",
      direction: t.messages[0]?.direction ?? null,
    })),
  );
}
