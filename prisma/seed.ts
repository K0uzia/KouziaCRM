import { PrismaClient } from "@prisma/client";
import { applyCatalog } from "../apps/api/src/lib/services/catalog";
import { ensureCompanySettings } from "../apps/api/src/lib/settings/seed-company";
import argon2 from "argon2";

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

  // Réglages : créés sur une base neuve ; sur une base existante, seuls les champs vides sont complétés.
  await ensureCompanySettings(prisma);

  const checklist = await prisma.startupChecklist.findFirst();
  if (!checklist) {
    await prisma.startupChecklist.create({ data: {} });
  }

  // Backfill CLI-xxxx (l'espace client se connecte par e-mail + code, plus de code d'accès)
  const clients = await prisma.client.findMany({
    where: { clientNumber: null },
    orderBy: { createdAt: "asc" },
  });
  if (clients.length > 0) {
    await prisma.namedCounter.upsert({
      where: { name: "client" },
      create: { name: "client", lastValue: 0 },
      update: {},
    });
  }
  for (const c of clients) {
    const counter = await prisma.namedCounter.update({
      where: { name: "client" },
      data: { lastValue: { increment: 1 } },
    });
    await prisma.client.update({
      where: { id: c.id },
      data: { clientNumber: `CLI-${pad(counter.lastValue)}` },
    });
  }

  // Catalogue de prestations et d'offres de maintenance (prix fixes), si aucun service.
  const serviceCount = await prisma.service.count();
  if (serviceCount === 0) {
    await applyCatalog(prisma);
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
