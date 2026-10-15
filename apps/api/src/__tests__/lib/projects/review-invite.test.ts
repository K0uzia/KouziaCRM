import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { encrypt } from "@/lib/crypto.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// SMTP « configuré » : l'email part dans la file d'envoi, jamais sur le réseau (pas de worker).
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));

const { createClientProject, projectInputSchema, updateClientProject } = await import("@/lib/projects/service.js");
const { reviewInviteEligible } = await import("@/lib/projects/review-invite.js");

const REVIEW_URL = "https://g.page/r/Cb8yzZKdc-SEEBM/review/";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { clientPortalUrl: "https://kouzia.com/suivi/" } });
  invalidateCompanySettingsCache();
  await prisma.emailOutbox.deleteMany();
});

afterEach(async () => {
  await resetDb();
});

const input = projectInputSchema.parse({ name: "Site vitrine", progress: 100 });

async function projectFor(email: string | null = "lou@example.test") {
  const client = await createClient({ displayName: "Lou Essai" });
  if (email) {
    await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(email) } });
  }
  const project = await createClientProject(client.id, { ...input, status: "ACTIVE" });
  return { client, project };
}

const invites = async () =>
  (await prisma.emailOutbox.findMany()).map((r) => parsePayload(r.payload)).filter((p) => p.kind === "review_invite");

describe("invitation à laisser un avis", () => {
  it("envoie un e-mail au passage à DONE, une seule fois par projet", async () => {
    const { client, project } = await projectFor();
    expect(await reviewInviteEligible(client.id)).toBe(false);

    const done = await updateClientProject(project.id, { ...input, status: "DONE" });
    expect(done.reviewInviteSentAt).not.toBeNull();
    const sent = await invites();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("lou@example.test");
    expect(sent[0]!.text).toContain(REVIEW_URL);
    expect(sent[0]!.text).toContain("« Site vitrine »");
    // Deux choix (témoignage et avis Google), sans condition de satisfaction ni contrepartie.
    expect(sent[0]!.text).toContain("Laisser un témoignage sur kouzia.com");
    expect(sent[0]!.text).toContain("Laisser un avis Google");
    expect(sent[0]!.text).not.toMatch(/satisfait|contrepartie|cadeau|réduction/i);
    expect(await reviewInviteEligible(client.id)).toBe(true);

    // Réouverture puis nouvelle livraison : pas de second e-mail.
    await updateClientProject(project.id, { ...input, status: "ACTIVE" });
    await updateClientProject(project.id, { ...input, status: "DONE" });
    await updateClientProject(project.id, { ...input, status: "DONE" });
    expect(await invites()).toHaveLength(1);
  });

  it("n'envoie rien et ne propose rien quand l'invitation est désactivée dans les réglages", async () => {
    await prisma.companySettings.updateMany({ data: { reviewInviteEnabled: false } });
    invalidateCompanySettingsCache();
    const { client, project } = await projectFor();
    const done = await updateClientProject(project.id, { ...input, status: "DONE" });
    expect(done.reviewInviteSentAt).toBeNull();
    expect(await invites()).toHaveLength(0);
    expect(await reviewInviteEligible(client.id)).toBe(false);
  });

  it("sans lien Google : seul le lien du témoignage ; sans aucun lien en https : rien", async () => {
    await prisma.companySettings.updateMany({ data: { googleReviewUrl: null, clientPortalUrl: "https://kouzia.com/suivi/" } });
    invalidateCompanySettingsCache();
    const first = await projectFor();
    await updateClientProject(first.project.id, { ...input, status: "DONE" });
    const [sent] = await invites();
    expect(sent!.text).toContain("https://kouzia.com/suivi/");
    expect(sent!.text).not.toContain("avis Google");

    await prisma.emailOutbox.deleteMany();
    await prisma.companySettings.updateMany({ data: { clientPortalUrl: null } });
    invalidateCompanySettingsCache();
    const second = await projectFor("paul@example.test");
    await updateClientProject(second.project.id, { ...input, status: "DONE" });
    expect(await invites()).toHaveLength(0);
  });

  it("sans e-mail client : le projet passe à DONE, sans invitation et sans repère posé", async () => {
    const { client, project } = await projectFor(null);
    const done = await updateClientProject(project.id, { ...input, status: "DONE" });
    expect(done.status).toBe("DONE");
    expect(done.reviewInviteSentAt).toBeNull();
    expect(await invites()).toHaveLength(0);
    // Le bouton de l'espace client reste proposé : le projet est livré.
    expect(await reviewInviteEligible(client.id)).toBe(true);
  });
});

describe("projet terminé", () => {
  it("affiche 100 % d'avancement, sans cocher les étapes ; rouvert, il reprend la valeur saisie", async () => {
    const { project } = await projectFor();
    const steps = [{ label: "Mise en ligne", status: "current" as const, date: null, triggersDeposit2: undefined }];
    const done = await updateClientProject(project.id, { ...input, progress: 90, steps, status: "DONE" });
    expect(done.progress).toBe(100);
    expect(done.steps[0]!.status).toBe("current");
    const reopened = await updateClientProject(project.id, { ...input, progress: 90, steps, status: "ACTIVE" });
    expect(reopened.progress).toBe(90);
  });

  it("un projet déjà terminé en base avec moins de 100 % s'affiche à 100 %", async () => {
    const { client, project } = await projectFor();
    await prisma.clientProject.update({ where: { id: project.id }, data: { status: "DONE", progress: 90 } });
    const { listPortalProjects } = await import("@/lib/projects/service.js");
    expect((await listPortalProjects(client.id))[0]!.progress).toBe(100);
  });
});
