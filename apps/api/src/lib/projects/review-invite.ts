import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { prisma } from "@/lib/prisma.js";

export const REVIEW_INVITE_KIND = "review_invite";

/** Lien d'avis utilisable : réglage actif et lien en https. */
function reviewUrlOf(settings: { reviewInviteEnabled: boolean; googleReviewUrl: string | null }): string | null {
  const url = settings.googleReviewUrl?.trim();
  return settings.reviewInviteEnabled && url?.startsWith("https://") ? url : null;
}

/** Espace client : bouton « Laisser un avis » dès qu'un projet du client est livré. */
export async function reviewInviteEligible(clientId: string): Promise<boolean> {
  if (!reviewUrlOf(await getCompanySettings())) return false;
  const done = await prisma.clientProject.count({ where: { clientId, status: "DONE" } });
  return done > 0;
}

/**
 * Au passage d'un projet à DONE : e-mail d'invitation, une seule fois par projet.
 * Le repère est posé avant l'envoi (updateMany conditionnel) : deux enregistrements simultanés
 * n'envoient qu'un e-mail. Il est retiré si la mise en file échoue, pour pouvoir réessayer.
 */
export async function sendReviewInviteOnDone(projectId: string): Promise<boolean> {
  const settings = await getCompanySettings();
  const url = reviewUrlOf(settings);
  if (!url || !(await isSmtpConfigured())) return false;

  const project = await prisma.clientProject.findUnique({
    where: { id: projectId },
    include: { client: true },
  });
  if (!project || project.status !== "DONE" || project.reviewInviteSentAt) return false;
  const email = decryptOptional(project.client.emailEncrypted);
  if (!email) return false;

  const claimed = await prisma.clientProject.updateMany({
    where: { id: projectId, reviewInviteSentAt: null },
    data: { reviewInviteSentAt: new Date() },
  });
  if (claimed.count !== 1) return false;

  try {
    const brand = settings.tradeName ?? settings.legalName;
    const first = project.client.firstName?.trim() || project.client.displayName.trim().split(/\s+/)[0];
    const text = [
      first ? `Bonjour ${first},` : "Bonjour,",
      "",
      `Votre projet « ${project.name} » est livré. Merci pour votre confiance.`,
      "",
      "Si vous en êtes satisfait, un avis sur Google m'aide beaucoup : il permet à d'autres clients de me trouver. Cela prend une minute :",
      "",
      url,
      "",
      "Une remarque ou une question ? Répondez simplement à cet e-mail.",
      "",
      formatPlainTextSignature(settings, await brandFromSettings()),
    ].join("\n");
    await mailEnqueue({
      to: email,
      subject: `Votre avis sur votre projet avec ${brand}`,
      text,
      clientId: project.clientId,
      kind: REVIEW_INVITE_KIND,
      bodyTextForMessage: text,
    });
    return true;
  } catch (err) {
    await prisma.clientProject.update({ where: { id: projectId }, data: { reviewInviteSentAt: null } });
    console.error(`[email] invitation à laisser un avis échouée pour le projet ${projectId}`, err);
    return false;
  }
}
