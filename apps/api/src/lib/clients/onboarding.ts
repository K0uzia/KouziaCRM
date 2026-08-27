import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { encryptOptional } from "@/lib/crypto.js";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp.js";
import { allocateClientNumber } from "@/lib/clients/numbering.js";
import { issueAndSendAccessCode } from "@/lib/clients/access-email.js";

const ONBOARDING_TTL_DAYS = 30;

export type OnboardingInviteResult = {
  ok: boolean;
  sent: boolean;
  reason?: "smtp_off" | "no_email" | "error";
  token: string;
};

/** Génère un token d'onboarding (32 hex) avec expiration à +30 jours. */
function generateOnboardingToken(): { token: string; expiresAt: Date } {
  const token = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + ONBOARDING_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

function originUrl(): string {
  return (
    process.env.PUBLIC_WEB_ORIGIN?.trim() ||
    process.env.WEB_ORIGIN?.trim() ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

/**
 * Crée une invitation d'onboarding pour un email donné.
 * - existingClientId null : nouveau prospect (le client sera créé à la soumission).
 * - existingClientId renseigné : client existant à mettre à jour.
 * Envoie l'email contenant le lien /onboarding/:token.
 */
export async function sendOnboardingInvite(opts: {
  email: string;
  existingClientId?: string | null;
}): Promise<OnboardingInviteResult> {
  const email = opts.email.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Email invalide");
  }

  const { token, expiresAt } = generateOnboardingToken();
  await prisma.onboardingInvitation.create({
    data: {
      email,
      token,
      expiresAt,
      existingClientId: opts.existingClientId ?? null,
    },
  });

  if (!isSmtpConfigured()) return { ok: true, sent: false, reason: "smtp_off", token };

  try {
    const company = await getCompanySettings();
    const brand = company.tradeName ?? company.legalName;
    const link = `${originUrl()}/onboarding/${token}`;

    const body = [
      "Bonjour,",
      "",
      opts.existingClientId
        ? "Pour mettre à jour vos informations de facturation, merci de compléter le formulaire sécurisé ci-dessous :"
        : "Pour me permettre de vous facturer dans les meilleures conditions, j'ai besoin de quelques informations vous concernant. Merci de prendre 2 minutes pour compléter votre fiche via le lien sécurisé ci-dessous :",
      "",
      link,
      "",
      "Ce lien est personnel et expire dans 30 jours. Vos informations sont chiffrées et stockées de façon sécurisée.",
      "",
      "Cordialement,",
      brand,
    ].join("\n");

    await sendEmail({
      to: email,
      subject: opts.existingClientId
        ? `Mise à jour de votre fiche client - ${brand}`
        : `Complétez votre fiche client - ${brand}`,
      text: body,
    });

    return { ok: true, sent: true, token };
  } catch (err) {
    console.error(`[email] envoi invitation onboarding échoué pour ${email}`, err);
    return { ok: true, sent: false, reason: "error", token };
  }
}

export type OnboardingView = {
  /** Email masqué pour affichage public (a***@domaine.fr) */
  emailMasked: string;
  /** Client existant à mettre à jour (null = nouveau client à créer) */
  existingClientId: string | null;
  existingType: "B2B" | "B2C" | null;
  displayName: string | null;
  completedAt: Date | null;
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

/** Récupère les infos pré-remplies pour le formulaire d'onboarding public. */
export async function getOnboardingView(token: string): Promise<OnboardingView | null> {
  const invitation = await prisma.onboardingInvitation.findUnique({
    where: { token },
    include: { existingClient: true },
  });
  if (!invitation) return null;
  if (invitation.usedAt) return { ...mapView(invitation), completedAt: invitation.usedAt };
  if (invitation.expiresAt < new Date()) return null;
  return { ...mapView(invitation), completedAt: null };
}

function mapView(inv: {
  email: string;
  existingClientId: string | null;
  existingClient: { type: "B2B" | "B2C"; displayName: string } | null;
}): OnboardingView {
  return {
    emailMasked: maskEmail(inv.email),
    existingClientId: inv.existingClientId,
    existingType: inv.existingClient?.type ?? null,
    displayName: inv.existingClient?.displayName ?? null,
    completedAt: null,
  };
}

export type OnboardingSubmission = {
  type: "B2B" | "B2C";
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  siret?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
};

function buildDisplayName(d: OnboardingSubmission): string {
  if (d.type === "B2B") return (d.companyName ?? "").trim() || "Société";
  return [d.firstName?.trim(), d.lastName?.trim()].filter(Boolean).join(" ") || "Client";
}

function toPrismaData(d: OnboardingSubmission) {
  const siret = d.siret?.replace(/\s/g, "") || null;
  return {
    type: d.type,
    displayName: buildDisplayName(d),
    firstName: d.firstName?.trim() || null,
    lastName: d.lastName?.trim() || null,
    companyName: d.companyName?.trim() || null,
    emailEncrypted: encryptOptional(d.email || null),
    phoneEncrypted: encryptOptional(d.phone || null),
    siretEncrypted: encryptOptional(siret),
    addressLine1: d.addressLine1?.trim() || null,
    addressLine2: d.addressLine2?.trim() || null,
    postalCode: d.postalCode?.trim() || null,
    city: d.city?.trim() || null,
    country: d.country?.trim() || "FRANCE",
  };
}

/**
 * Valide et applique la soumission d'onboarding.
 * - Crée un nouveau client (avec numéro + code d'accès) si pas de existingClient.
 * - Met à jour le client existant sinon.
 * Marque l'invitation comme utilisée.
 */
export async function submitOnboarding(
  token: string,
  data: OnboardingSubmission,
): Promise<{ ok: boolean; error?: string }> {
  const invitation = await prisma.onboardingInvitation.findUnique({
    where: { token },
  });
  if (!invitation) return { ok: false, error: "Lien invalide ou expiré" };
  if (invitation.usedAt) {
    return { ok: false, error: "Ce formulaire a déjà été soumis." };
  }
  if (invitation.expiresAt < new Date()) {
    return { ok: false, error: "Ce lien a expiré. Contactez-moi pour en recevoir un nouveau." };
  }

  // Validation métier
  if (data.type === "B2B" && !data.companyName?.trim()) {
    return { ok: false, error: "Raison sociale requise pour un professionnel" };
  }
  if (data.type === "B2C" && !data.lastName?.trim()) {
    return { ok: false, error: "Nom requis pour un particulier" };
  }
  if (data.siret && !/^\d{14}$/.test(data.siret.replace(/\s/g, ""))) {
    return { ok: false, error: "SIRET invalide (14 chiffres)" };
  }

  // Email imposé par l'invitation (jamais celui du body public)
  const locked: OnboardingSubmission = { ...data, email: invitation.email };
  const now = new Date();

  if (invitation.existingClientId) {
    // Mise à jour d'un client existant
    await prisma.client.update({
      where: { id: invitation.existingClientId },
      data: { ...toPrismaData(locked), onboardingCompletedAt: now },
    });
    await prisma.onboardingInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: now },
    });
    // Identifiants de suivi : générés + email auto (récupérables uniquement via le mail)
    await issueAndSendAccessCode(invitation.existingClientId).catch((err) => {
      console.error(`[email] code suivi après onboarding (existant) échoué`, err);
    });
    return { ok: true };
  }

  // Création d'un nouveau client (numéro CLI uniquement; code d'accès + email ensuite)
  const clientNumber = await allocateClientNumber();
  const created = await prisma.client.create({
    data: {
      ...toPrismaData(locked),
      clientNumber,
      accessCodeHash: null,
      onboardingCompletedAt: now,
    },
  });
  await prisma.onboardingInvitation.update({
    where: { id: invitation.id },
    data: { usedAt: now, createdClientId: created.id },
  });

  await issueAndSendAccessCode(created.id).catch((err) => {
    console.error(`[email] code suivi après onboarding (nouveau) échoué`, err);
  });

  return { ok: true };
}
