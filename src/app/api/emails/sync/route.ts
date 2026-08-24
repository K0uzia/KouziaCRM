import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isImapConfigured, syncImapInbox } from "@/lib/email/imap-sync";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isImapConfigured()) {
    return NextResponse.json({ error: "IMAP non configuré" }, { status: 400 });
  }

  const result = await syncImapInbox();
  return NextResponse.json(result);
}
