import { prisma } from "@/lib/prisma.js";

// Ordre enfants → parents (FK SQLite).
const TABLES = [
  "QuoteAcceptanceAudit",
  "EmailAttachment",
  "RevolutWebhookEvent",
  "EmailMessage",
  "EmailThread",
  "MailFolder",
  "MailAccount",
  "MailSyncStatus",
  "EmailSyncState",
  "EmailOutbox",
  "Payment",
  "InvoiceLine",
  "PaymentMilestone",
  "Invoice",
  "Subscription",
  "Service",
  "OnboardingInvitation",
  "ClientTestimonial",
  "Client",
  "Counter",
  "NamedCounter",
  "Obligation",
  "StartupChecklist",
  "UrssafDeclaration",
  "LegalClause",
  "Session",
  "SettingsAuditLog",
];

/** Vide toutes les tables métier (garde User et CompanySettings seedés). */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  try {
    for (const t of TABLES) {
      await (prisma as unknown as Record<string, { deleteMany: () => Promise<unknown> }>)[
        t
      ].deleteMany();
    }
  } finally {
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }
}

/** Vide une table précise. */
export async function clearTable(name: string): Promise<void> {
  await (prisma as unknown as Record<string, { deleteMany: () => Promise<unknown> }>)[
    name
  ].deleteMany();
}

export { prisma };
