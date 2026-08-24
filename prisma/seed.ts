import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "admin@kouzia.com").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD ?? "change-me-on-first-login";
  const name = process.env.ADMIN_NAME ?? "Alexandre Kouziaeff";

  if (!process.env.ADMIN_PASSWORD) {
    console.warn(
      "ADMIN_PASSWORD absent du .env — mot de passe par défaut utilisé. Définissez-le puis relancez npm run db:seed."
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.user.upsert({
    where: { email },
    update: { name, passwordHash },
    create: { email, name, passwordHash },
  });

  const existing = await prisma.companySettings.findFirst();
  if (!existing) {
    await prisma.companySettings.create({
      data: {
        legalName: "Alexandre Kouziaeff",
        tradeName: "Kouzia",
        siren: "108580028",
        siret: "10858002800018",
        apeCode: "6201Z",
        addressLine1: "13 Le Petit Moulin",
        postalCode: "29690",
        city: "Huelgoat",
        country: "FRANCE",
        website: "kouzia.com",
        vatRegime: "FRANCHISE_BASE_293B",
        vatMention: "TVA non applicable, art. 293 B du CGI",
        urssafRateBps: 2130,
        treasuryRateBps: 1420,
        placementRateBps: 1000,
        urssafPeriodicity: "MONTHLY",
        urssafDeadlineDay: 5,
        publicodesRegime: "AE_BNC_LIBERAL",
      },
    });
  } else {
    await prisma.companySettings.update({
      where: { id: existing.id },
      data: {
        treasuryRateBps: 1420,
        placementRateBps: 1000,
        urssafPeriodicity: "MONTHLY",
        urssafDeadlineDay: 5,
        publicodesRegime: existing.publicodesRegime || "AE_BNC_LIBERAL",
      },
    });
  }

  console.log("Seed OK:", { admin: email, company: "Kouzia / Alexandre Kouziaeff" });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
