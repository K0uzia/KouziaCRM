import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { prisma } from "@/lib/prisma.js";

export const REVIEW_INVITE_KIND = "review_invite";

const httpsOrNull = (url: string | null | undefined) => (url?.trim().startsWith("https://") ? url.trim() : null);

/** Lien d'avis Google utilisable : réglage actif et lien en https. */
function reviewUrlOf(settings: { reviewInviteEnabled: boolean; googleReviewUrl: string | null }): string | null {
  return settings.reviewInviteEnabled ? httpsOrNull(settings.googleReviewUrl) : null;
}

/** Liens de l'invitation : témoignage dans l'espace client et avis Google ; au moins un, réglage actif. */
function inviteLinksOf(settings: { reviewInviteEnabled: boolean; googleReviewUrl: string | null; clientPortalUrl: string | null }) {
  if (!settings.reviewInviteEnabled) return null;
  const testimonial = httpsOrNull(settings.clientPortalUrl);
  const google = httpsOrNull(settings.googleReviewUrl);
  return testimonial || google ? { testimonial, google } : null;
}

/** Espace client : bouton « Laisser un avis » dès qu'un projet du client est livré. */
export async function reviewInviteEligible(clientId: string): Promise<boolean> {
  if (!reviewUrlOf(await getCompanySettings())) return false;
  const done = await prisma.clientProject.count({ where: { clientId, status: "DONE" } });
  return done > 0;
}

/**
 * Au passage d'un projet à DONE : e-mail d'invitation, une seule fois par projet, pour TOUS les projets
 * terminés, sans condition de satisfaction ni contrepartie (pas de sollicitation sélective des avis).
 * Deux choix : un témoignage sur kouzia.com (espace client) et un avis Google.
 * Le repère est posé avant l'envoi (updateMany conditionnel) : deux enregistrements simultanés
 * n'envoient qu'un e-mail. Il est retiré si la mise en file échoue, pour pouvoir réessayer.
 */
export async function sendReviewInviteOnDone(projectId: string): Promise<boolean> {
  const settings = await getCompanySettings();
  const links = inviteLinksOf(settings);
  if (!links || !(await isSmtpConfigured())) return false;

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
      "Votre retour sur notre travail ensemble m'intéresse, quel qu'il soit. Si vous le souhaitez, vous pouvez le partager :",
      "",
      ...(links.testimonial
        ? ["Laisser un témoignage sur kouzia.com (depuis votre espace client) :", links.testimonial, ""]
        : []),
      ...(links.google ? ["Laisser un avis Google :", links.google, ""] : []),
      "Une remarque ou une question ? Répondez simplement à cet e-mail.",
      "",
      formatPlainTextSignature(settings, await brandFromSettings()),
    ].join("\n");
    await mailEnqueue({
      to: email,
      subject: `Votre retour sur votre projet avec ${brand}`,
      text,
      clientId: project.clientId,
      kind: REVIEW_INVITE_KIND,
      bodyTextForMessage: text,
    }, { review: { family: "review_invite", origin: "ADMIN_ACTION" } });
    return true;
  } catch (err) {
    await prisma.clientProject.update({ where: { id: projectId }, data: { reviewInviteSentAt: null } });
    console.error(`[email] invitation à laisser un avis échouée pour le projet ${projectId}`, err);
    return false;
  }
}
