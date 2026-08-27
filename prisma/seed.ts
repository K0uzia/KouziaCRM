import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";

const prisma = new PrismaClient();

function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "admin@kouzia.com").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD ?? "change-me-on-first-login";
  const name = process.env.ADMIN_NAME ?? "Alexandre Kouziaeff";
  const isProd = process.env.NODE_ENV === "production";

  const WEAK_PASSWORDS = new Set([
    "change-me-on-first-login",
    "1234",
    "admin",
    "password",
    "change-me",
  ]);

  function isWeakPassword(p: string): boolean {
    return WEAK_PASSWORDS.has(p) || p.length < 12;
  }

  if (!process.env.ADMIN_PASSWORD) {
    if (isProd) {
      throw new Error(
        "ADMIN_PASSWORD absent du .env en production. Définissez un mot de passe d'au moins 12 caractères.",
      );
    }
    console.warn(
      "ADMIN_PASSWORD absent du .env - mot de passe par défaut utilisé. Définissez-le puis relancez npm run db:seed.",
    );
  } else if (isWeakPassword(password) && isProd) {
    throw new Error(
      "ADMIN_PASSWORD trop faible en production (doit faire >= 12 caractères et ne pas être une valeur connue).",
    );
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

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
        paymentConditions: "Paiement à réception",
        reminderQuoteDays: 7,
        reminderInvoiceDays: 7,
        publicTrackingShowAmounts: true,
        businessStartDate: new Date("2025-01-15"),
        cfeAmountCents: 25000,
        b2cActivity: true,
        mediationClause:
          "En cas de litige non résolu, le client peut recourir gratuitement à un médiateur de la consommation : voir medic.conso.fr",
        incomeTaxReminderMonth: 4,
        incomeTaxReminderDay: 15,
      },
    });
  } else {
    await prisma.companySettings.update({
      where: { id: existing.id },
      data: {
        treasuryRateBps: 1420,
        placementRateBps: 1000,
        urssafPeriodicity: "MONTHLY",
        urssafDeadlineDay: existing.urssafDeadlineDay || 5,
        publicodesRegime: existing.publicodesRegime || "AE_BNC_LIBERAL",
        businessStartDate: existing.businessStartDate ?? new Date("2025-01-15"),
        publicTrackingShowAmounts: true,
      },
    });
  }

  const checklist = await prisma.startupChecklist.findFirst();
  if (!checklist) {
    await prisma.startupChecklist.create({ data: {} });
  }

  // Backfill CLI-xxxx + codes d'accès
  const clients = await prisma.client.findMany({ orderBy: { createdAt: "asc" } });
  let counter = await prisma.namedCounter.findUnique({ where: { name: "client" } });
  if (!counter) {
    counter = await prisma.namedCounter.create({ data: { name: "client", lastValue: 0 } });
  }

  const accessCodes: Array<{ clientNumber: string; displayName: string; accessCode: string }> =
    [];

  for (const c of clients) {
    let clientNumber = c.clientNumber;
    if (!clientNumber) {
      counter = await prisma.namedCounter.update({
        where: { name: "client" },
        data: { lastValue: { increment: 1 } },
      });
      clientNumber = `CLI-${pad(counter.lastValue)}`;
    }

    let accessCodeHash = c.accessCodeHash;
    let accessCode: string | null = null;
    if (!accessCodeHash) {
      accessCode = randomBytes(4).toString("hex").toUpperCase();
      accessCodeHash = await argon2.hash(accessCode, { type: argon2.argon2id });
    }

    if (clientNumber !== c.clientNumber || accessCodeHash !== c.accessCodeHash) {
      await prisma.client.update({
        where: { id: c.id },
        data: { clientNumber, accessCodeHash },
      });
    }

    if (accessCode) {
      accessCodes.push({
        clientNumber,
        displayName: c.displayName,
        accessCode,
      });
    }
  }

  // Sample services if empty
  const serviceCount = await prisma.service.count();
  if (serviceCount === 0) {
    await prisma.service.createMany({
      data: [
        {
          name: "Conseil technique",
          description: "Accompagnement et conseil",
          unitPriceCents: 75000,
          unit: "JOUR",
          active: true,
        },
        {
          name: "Développement",
          description: "Prestation de développement logiciel",
          unitPriceCents: 65000,
          unit: "JOUR",
          active: true,
        },
        {
          name: "Forfait projet",
          description: "Mission forfaitaire",
          unitPriceCents: 250000,
          unit: "FORFAIT",
          active: true,
        },
        {
          name: "Maintenance site web",
          description: "Maintenance mensuelle de site web (abonnement récurrent)",
          unitPriceCents: 15000,
          unit: "MENSUEL",
          active: true,
          isSubscription: true,
          defaultBillingDay: 1,
        },
      ],
    });
  }

  // Abonnement d'exemple (dev only) pour faciliter les tests du MRR/worker.
  if (process.env.NODE_ENV !== "production") {
    const subCount = await prisma.subscription.count();
    if (subCount === 0) {
      const sampleClient = await prisma.client.findFirst({ orderBy: { createdAt: "asc" } });
      const sampleService = await prisma.service.findFirst({ orderBy: { name: "asc" } });
      if (sampleClient && sampleService) {
        const start = new Date();
        const nextInvoiceAt = new Date(
          start.getFullYear(),
          start.getMonth(),
          5,
          0,
          0,
          0,
          0,
        );
        if (nextInvoiceAt < start) nextInvoiceAt.setMonth(nextInvoiceAt.getMonth() + 1);
        await prisma.subscription.create({
          data: {
            clientId: sampleClient.id,
            serviceId: sampleService.id,
            label: "Maintenance mensuelle",
            amountCents: 30000,
            billingDay: 5,
            startDate: start,
            status: "ACTIVE",
            nextInvoiceAt,
          },
        });
        console.log("Seed: abonnement d'exemple créé (dev only)");
      }
    }
  }

  console.log("Seed OK:", { admin: email, company: "Kouzia / Alexandre Kouziaeff" });
  if (accessCodes.length > 0) {
    console.log("Codes d'accès suivi public (affichés une seule fois) :");
    for (const row of accessCodes) {
      console.log(`  ${row.clientNumber} (${row.displayName}) : ${row.accessCode}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
