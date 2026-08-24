import { NextResponse } from "next/server";
import { z } from "zod";
import { UrssafPeriodicity } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const company = await getCompanySettings();
  return NextResponse.json(company);
}

const patchSchema = z.object({
  urssafPeriodicity: z.nativeEnum(UrssafPeriodicity).optional(),
  urssafDeadlineDay: z.number().int().min(1).max(28).optional(),
  treasuryRateBps: z.number().int().min(0).max(5000).optional(),
  placementRateBps: z.number().int().min(0).max(5000).optional(),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const current = await getCompanySettings();
  const updated = await prisma.companySettings.update({
    where: { id: current.id },
    data: parsed.data,
  });
  invalidateCompanySettingsCache();
  return NextResponse.json(updated);
}
