import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailOutboxStatus, InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/auth.js";
import { purgeRetention } from "@/lib/privacy/retention.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

const NOW = new Date("2030-06-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

/** Client dont la fiche n'a pas bougé depuis `days` jours. */
async function client(name: string, days: number) {
  const c = await createClient({ displayName: name });
  // updatedAt fourni explicitement : Prisma le garde au lieu de la date du jour.
  await prisma.client.update({ where: { id: c.id }, data: { updatedAt: ago(days) } });
  return c;
}

describe("conservation des données (worker, chaque heure)", () => {
  it("prospect sans suite depuis 3 ans supprimé ; client avec document, abonnement, projet ou avis, ou contacté récemment : gardé", async () => {
    const stale = await client("Prospect ancien", 1200);
    await prisma.emailThread.create({ data: { participants: "[]", subject: "Demande", clientId: stale.id, lastMessageAt: ago(1200) } });
    const recentFile = await client("Prospect récent", 300);
    const recentMail = await client("Contacté récemment", 1200);
    await prisma.clientEmailEvent.create({ data: { clientId: recentMail.id, kind: "access", subject: "Accès", toAddress: "", sentAt: ago(100) } });
    const recentThread = await client("Fil récent", 1200);
    await prisma.emailThread.create({ data: { participants: "[]", subject: "Relance", clientId: recentThread.id, lastMessageAt: ago(200) } });
    const draft = await client("Avec brouillon", 1200);
    await prisma.invoice.create({ data: { clientId: draft.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, subtotalCents: 1, totalCents: 1 } });
    const project = await client("Avec projet", 1200);
    await prisma.clientProject.create({ data: { clientId: project.id, name: "Projet" } });
    const review = await client("Avec avis", 1200);
    await prisma.siteReview.create({ data: { clientId: review.id, author: "A.", text: "Bien.", reviewedOn: "2026-01-01" } });

    const res = await purgeRetention(NOW);
    expect(res.prospects).toBe(1);
    expect(await prisma.client.findUnique({ where: { id: stale.id } })).toBeNull();
    // Fil sans échange depuis plus de 3 ans : retiré lui aussi (messagerie, décision d'Alexandre du 27/10/2026).
    expect(await prisma.emailThread.count({ where: { subject: "Demande" } })).toBe(0);
    expect(res.mailThreads).toBe(1);
    for (const kept of [recentFile, recentMail, recentThread, draft, project, review]) {
      expect(await prisma.client.findUnique({ where: { id: kept.id } }), kept.displayName).not.toBeNull();
    }
  });

  it("invitations expirées ou utilisées depuis 30 jours, contenu des e-mails envoyés depuis 30 jours, journal de plus d'un an", async () => {
    await prisma.onboardingInvitation.createMany({
      data: [
        { email: "", token: "utilisee-ancienne", expiresAt: ago(10), usedAt: ago(31) },
        { email: "", token: "expiree-ancienne", expiresAt: ago(31) },
        { email: "", token: "utilisee-recente", expiresAt: ago(10), usedAt: ago(5) },
        { email: "", token: "valide", expiresAt: ago(-5) },
      ],
    });
    const sentOld = await prisma.emailOutbox.create({ data: { status: EmailOutboxStatus.SENT, sentAt: ago(31), payload: "", payloadEncrypted: "chiffre" } });
    const sentRecent = await prisma.emailOutbox.create({ data: { status: EmailOutboxStatus.SENT, sentAt: ago(5), payload: "", payloadEncrypted: "chiffre" } });
    const failedOld = await prisma.emailOutbox.create({ data: { status: EmailOutboxStatus.FAILED, payload: "", payloadEncrypted: "chiffre", createdAt: ago(60) } });
    const c = await client("Client", 10);
    await prisma.clientEmailEvent.createMany({
      data: [
        { clientId: c.id, kind: "document", subject: "Vieux", toAddress: "", sentAt: ago(366) },
        { clientId: c.id, kind: "document", subject: "Récent", toAddress: "", sentAt: ago(30) },
      ],
    });

    const res = await purgeRetention(NOW);
    expect(res).toMatchObject({ invitations: 2, outbox: 1, emailEvents: 1 });
    expect((await prisma.onboardingInvitation.findMany({ orderBy: { token: "asc" } })).map((i) => i.token)).toEqual(["utilisee-recente", "valide"]);
    expect(await prisma.emailOutbox.findUniqueOrThrow({ where: { id: sentOld.id } })).toMatchObject({ payload: "", payloadEncrypted: null, status: "SENT" });
    expect((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: sentRecent.id } })).payloadEncrypted).toBe("chiffre");
    // Échec : contenu gardé pour un nouvel essai manuel.
    expect((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: failedOld.id } })).payloadEncrypted).toBe("chiffre");
    expect((await prisma.clientEmailEvent.findMany()).map((e) => e.subject)).toEqual(["Récent"]);
  });

  it("sessions admin : expirées ou inactives depuis 24 h supprimées, sessions actives gardées", async () => {
    await prisma.user.deleteMany({ where: { email: "admin-retention@kouzia.test" } });
    const user = await prisma.user.create({ data: { email: "admin-retention@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") } });
    await prisma.session.createMany({
      data: [
        { id: "expiree", userId: user.id, expiresAt: ago(1) },
        { id: "inactive", userId: user.id, expiresAt: ago(-3), lastSeenAt: ago(2) },
        { id: "active", userId: user.id, expiresAt: ago(-3), lastSeenAt: ago(0.1) },
        { id: "ancienne-sans-activite", userId: user.id, expiresAt: ago(-3) },
      ],
    });
    expect((await purgeRetention(NOW)).sessions).toBe(2);
    expect((await prisma.session.findMany({ orderBy: { id: "asc" } })).map((s) => s.id)).toEqual(["active", "ancienne-sans-activite"]);
  });
});
