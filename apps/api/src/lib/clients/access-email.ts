import { getCompanySettings } from "@/lib/company.js";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp.js";
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
 * d'accès secret, le lien de la page publique /suivi et une explication
 * de l'utilité du suivi.
 */
export async function sendClientAccessEmail(opts: {
  clientId: string;
  clientNumber: string | null;
  displayName: string;
  email: string;
  accessCode: string;
}): Promise<SendAccessEmailResult> {
  if (!isSmtpConfigured()) return { sent: false, reason: "smtp_off" };
  if (!opts.email) return { sent: false, reason: "no_email" };

  try {
    const company = await getCompanySettings();
    const brand = company.tradeName ?? company.legalName;
    const origin =
      process.env.PUBLIC_WEB_ORIGIN?.trim() ||
      process.env.WEB_ORIGIN?.trim() ||
      "http://localhost:5173";
    const trackingUrl = `${origin.replace(/\/$/, "")}/suivi`;
    const firstName = opts.displayName.trim().split(/\s+/)[0] || "";

    const body = [
      firstName ? `Bonjour ${firstName},` : "Bonjour,",
      "",
      "Pour suivre l'avancement de vos devis et factures en ligne, voici vos identifiants de connexion à votre espace client :",
      "",
      `Code de suivi : ${opts.clientNumber ?? "(non encore attribué)"}`,
      `Code d'accès : ${opts.accessCode}`,
      "",
      `Page de connexion : ${trackingUrl}`,
      "",
      "Comment les utiliser ?",
      "- Rendez-vous sur la page de connexion indiquée ci-dessus.",
      "- Saisissez votre code de suivi (votre identifiant unique, au format CLI-XXXX) et votre code d'accès.",
      "- Vous accédez alors à la liste de vos documents (devis, factures, avoirs) et à leur statut.",
      "",
      "Conservez précieusement votre code d'accès : il est personnel et confidentiel. En cas de perte, contactez-moi pour en générer un nouveau.",
      "",
      "Cordialement,",
      brand,
    ].join("\n");

    await sendEmail({
      to: opts.email,
      subject: `Vos identifiants de suivi - ${brand}`,
      text: body,
    });

    return { sent: true };
  } catch (err) {
    console.error(`[email] envoi identifiants suivi échoué pour client ${opts.clientId}`, err);
    return { sent: false, reason: "error" };
  }
}
