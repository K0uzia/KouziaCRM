import { getCompanySettings } from "@/lib/company.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { generateAccessCode } from "@/lib/clients/numbering.js";
import { decryptOptional, encrypt } from "@/lib/crypto.js";
import { prisma } from "@/lib/prisma.js";

export type SendAccessEmailResult = {
  sent: boolean;
  reason?: "smtp_off" | "no_email" | "error";
};

export type IssueAccessResult = {
  accessCode: string;
  accessEmailSent: boolean;
  accessEmailReason?: SendAccessEmailResult["reason"];
};

/**
 * Génère un nouveau code d'accès, le stocke (hash), et envoie l'email si possible.
 * Le code clair n'est récupérable que via cet email (ou la réponse API admin).
 */
export async function issueAndSendAccessCode(clientId: string): Promise<IssueAccessResult> {
  const existing = await prisma.client.findUnique({ where: { id: clientId } });
  if (!existing) throw new Error("Client introuvable");

  const access = await generateAccessCode();
  await prisma.client.update({
    where: { id: clientId },
    data: {
      accessCodeHash: access.hash,
      accessCodeEncrypted: encrypt(access.code),
    },
  });

  const email = decryptOptional(existing.emailEncrypted);
  if (!email) {
    return { accessCode: access.code, accessEmailSent: false, accessEmailReason: "no_email" };
  }

  const res = await sendClientAccessEmail({
    clientId: existing.id,
    clientNumber: existing.clientNumber,
    displayName: existing.displayName,
    email,
    accessCode: access.code,
  });

  if (res.sent) {
    await prisma.client.update({
      where: { id: clientId },
      data: { accessEmailSentAt: new Date() },
    });
  }

  return {
    accessCode: access.code,
    accessEmailSent: res.sent,
    accessEmailReason: res.reason,
  };
}

/**
 * Envoie au client un email contenant son code de suivi (CLI-xxxx), son code
 * d'accès secret et le lien du portail client.
 */
export async function sendClientAccessEmail(opts: {
  clientId: string;
  clientNumber: string | null;
  displayName: string;
  email: string;
  accessCode: string;
}): Promise<SendAccessEmailResult> {
  if (!(await isSmtpConfigured())) return { sent: false, reason: "smtp_off" };
  if (!opts.email) return { sent: false, reason: "no_email" };

  try {
    const company = await getCompanySettings();
    const brand = company.tradeName ?? company.legalName;
    const trackingUrl = await resolveClientPortalUrl();
    const clientNumber = opts.clientNumber?.trim() ?? "";
    const trackingDeepLink = clientNumber
      ? (() => {
          const url = new URL(trackingUrl);
          url.searchParams.set("reference", clientNumber);
          url.searchParams.set("code", opts.accessCode);
          return url.toString();
        })()
      : trackingUrl;
    const firstName = opts.displayName.trim().split(/\s+/)[0] || "";

    const body = [
      firstName ? `Bonjour ${firstName},` : "Bonjour,",
      "",
      "Pour suivre l'avancement de vos devis et factures en ligne, voici vos identifiants de connexion à votre espace client :",
      "",
      `Code de suivi : ${opts.clientNumber ?? "(non encore attribué)"}`,
      `Code d'accès : ${opts.accessCode}`,
      "",
      `Accès direct : ${trackingDeepLink}`,
      `Page de connexion : ${trackingUrl}`,
      "",
      "Comment les utiliser ?",
      "- Cliquez sur le lien d'accès direct : votre espace s'ouvre, le code n'est pas laissé dans l'adresse ensuite.",
      "- Sinon, rendez-vous sur la page de connexion et saisissez votre code de suivi (CLI-XXXX) et votre code d'accès.",
      "- Vous accédez alors à la liste de vos documents (devis, factures, avoirs) et à leur statut.",
      "",
      "Conservez précieusement votre code d'accès : il est personnel et confidentiel. En cas de perte, contactez-moi pour en générer un nouveau.",
      "",
      "Cordialement,",
      brand,
    ].join("\n");

    const subject = `Vos identifiants de suivi - ${brand}`;
    await mailEnqueue({
      to: opts.email,
      subject,
      text: body,
      clientId: opts.clientId,
      kind: "access",
      markAccessEmailSent: true,
      bodyTextForMessage: body,
    });

    return { sent: true };
  } catch (err) {
    console.error(`[email] envoi identifiants suivi échoué pour client ${opts.clientId}`, err);
    return { sent: false, reason: "error" };
  }
}
