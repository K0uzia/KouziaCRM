import { NextResponse } from "next/server";
import { z } from "zod";
import { EmailDirection } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp";
import { findClientIdByEmail } from "@/lib/email/match-client";

const schema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isSmtpConfigured()) {
    return NextResponse.json(
      { error: "SMTP non configuré (SMTP_HOST / SMTP_USER / SMTP_FROM)" },
      { status: 400 },
    );
  }

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { to, subject, body, threadId, inReplyTo } = parsed.data;
  const clientId = await findClientIdByEmail(to);

  let resolvedThreadId = threadId;
  if (!resolvedThreadId) {
    const thread = await prisma.emailThread.create({
      data: {
        subject,
        participants: JSON.stringify([to, process.env.SMTP_FROM || ""]),
        clientId,
        lastMessageAt: new Date(),
      },
    });
    resolvedThreadId = thread.id;
  } else {
    await prisma.emailThread.update({
      where: { id: resolvedThreadId },
      data: {
        lastMessageAt: new Date(),
        clientId: clientId ?? undefined,
      },
    });
  }

  const sent = await sendEmail({
    to,
    subject,
    text: body,
    headers: inReplyTo ? { "In-Reply-To": inReplyTo, References: inReplyTo } : undefined,
  });

  const message = await prisma.emailMessage.create({
    data: {
      threadId: resolvedThreadId,
      direction: EmailDirection.OUTBOUND,
      messageId: sent.messageId || `outbound-${Date.now()}@kouzia.local`,
      inReplyTo: inReplyTo || null,
      fromAddress: (process.env.SMTP_FROM || "").toLowerCase(),
      toAddresses: JSON.stringify([to.toLowerCase()]),
      subject,
      bodyText: body,
      receivedAt: new Date(),
    },
  });

  return NextResponse.json({ threadId: resolvedThreadId, message }, { status: 201 });
}
