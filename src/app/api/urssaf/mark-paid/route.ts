import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { markUrssafPaid } from "@/lib/finance/dashboard-service";

const schema = z.object({
  periodKey: z.string().optional(),
  paymentRef: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const decl = await markUrssafPaid(body.data);
  return NextResponse.json(decl);
}
