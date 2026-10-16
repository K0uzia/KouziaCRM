import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";

// Ordre enfants → parents (FK SQLite).
const TABLES = [
  "QuoteAcceptanceAudit",
  "EmailAttachment",
  "RevolutWebhookEvent",
  "StripeWebhookEvent",
  "EmailMessage",
  "EmailThread",
  "MailFolder",
  "MailAccount",
  "MailSyncStatus",
  "EmailSyncState",
  "EmailOutbox",
  "Payment",
  "StripePayout",
  "OwnerWithdrawal",
  "InvoiceLine",
  "PaymentMilestone",
  "Invoice",
  "Subscription",
  "Service",
  "OnboardingInvitation",
  "ClientEmailEvent",
  "ClientTestimonial",
  "PortalCode",
  "PortalSession",
  "ClientRenewal",
  "Client",
  "Counter",
  "NamedCounter",
  "Obligation",
  "StartupChecklist",
  "UrssafDeclaration",
  "LegalClause",
  "Session",
  "AdminRecoveryCode",
  "AdminLoginChallenge",
  "AdminDevice",
  "SettingsAuditLog",
  "SiteDeployEvent",
  "SitePublication",
  "SiteProject",
  "SiteReview",
  "SiteReference",
  "SiteFaq",
  "SiteText",
  "SiteMedia",
];

/** Vide toutes les tables métier (garde User ; CompanySettings est recréé par seedCompanySettings). */
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
  invalidateCompanySettingsCache();
}

/** Vide une table précise. */
export async function clearTable(name: string): Promise<void> {
  await (prisma as unknown as Record<string, { deleteMany: () => Promise<unknown> }>)[
    name
  ].deleteMany();
}

export { prisma };
