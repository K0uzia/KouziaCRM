import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { encryptOptional } from "@/lib/crypto.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { allocateClientNumber } from "@/lib/clients/numbering.js";
import { issueAndSendAccessCode } from "@/lib/clients/access-email.js";
import {
  createOnboardingToken,
  getOnboardingTtlDays,
  isLegacyOnboardingToken,
  verifyOnboardingToken,
} from "@/lib/clients/onboarding-token.js";
import {
  normalizeFrenchAddress,
  verifyCompanyIdentifiers,
} from "@/lib/address/france.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

export type OnboardingInviteResult = {
  ok: boolean;
  sent: boolean;
  reason?: "smtp_off" | "no_email" | "error";
  token: string;
};

function publicSiteOrigin(): string {
  return (
    process.env.PUBLIC_WEB_ORIGIN?.trim() ||
    process.env.WEB_ORIGIN?.trim() ||
    "http://localhost:5174"
  ).replace(/\/$/, "");
}

/**
 * Crée une invitation d'onboarding pour un email donné.
 * - existingClientId null : nouveau prospect (le client sera créé à la soumission).
 * - existingClientId renseigné : client existant à mettre à jour.
 * Envoie l'email contenant le lien Kouzia /nouveau-client?token=...
 */
export async function sendOnboardingInvite(opts: {
  email: string;
  existingClientId?: string | null;
}): Promise<OnboardingInviteResult> {
  const email = opts.email.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Email invalide");
  }

  const { token, jti, expiresAt } = createOnboardingToken({
    email,
    existingClientId: opts.existingClientId ?? null,
  });

  await prisma.onboardingInvitation.create({
    data: {
      email,
      token: jti,
      jti,
      expiresAt,
      existingClientId: opts.existingClientId ?? null,
    },
  });

  if (!(await isSmtpConfigured())) return { ok: true, sent: false, reason: "smtp_off", token };

  try {
    const company = await getCompanySettings();
    const brand = company.tradeName ?? company.legalName;
    const ttl = getOnboardingTtlDays();
    const link = `${publicSiteOrigin()}/nouveau-client?token=${encodeURIComponent(token)}`;

    const body = [
      "Bonjour,",
      "",
      opts.existingClientId
        ? "Pour mettre à jour vos informations de facturation, merci de compléter le formulaire sécurisé ci-dessous :"
        : "Pour me permettre de vous facturer dans les meilleures conditions, j'ai besoin de quelques informations vous concernant. Merci de prendre 2 minutes pour compléter votre fiche via le lien sécurisé ci-dessous :",
      "",
      link,
      "",
      `Ce lien est personnel et expire dans ${ttl} jours. Vos données sont transmises directement à ${brand} et ne sont pas conservées sur le site public.`,
      "",
      "Cordialement,",
      brand,
    ].join("\n");

    const subject = opts.existingClientId
      ? `Mise à jour de votre fiche client - ${brand}`
      : `Complétez votre fiche client - ${brand}`;
    await mailEnqueue({
      to: email,
      subject,
      text: body,
      clientId: opts.existingClientId ?? undefined,
      kind: "onboarding",
      bodyTextForMessage: body,
    });

    return { ok: true, sent: true, token };
  } catch (err) {
    console.error(`[email] envoi invitation onboarding échoué pour ${email}`, err);
    return { ok: true, sent: false, reason: "error", token };
  }
}

export type OnboardingView = {
  emailMasked: string;
  existingClientId: string | null;
  existingType: "B2B" | "B2C" | null;
  displayName: string | null;
  completedAt: Date | null;
  brandName: string | null;
};

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

async function brandName(): Promise<string | null> {
  try {
    const company = await getCompanySettings();
    return company.tradeName ?? company.legalName;
  } catch {
    return null;
  }
}

/** Preview pour le formulaire public Kouzia (token HMAC). */
export async function getPublicClientPreview(
  token: string,
): Promise<OnboardingView | null> {
  const payload = verifyOnboardingToken(token);
  if (!payload) {
    // Compat legacy : token hex 32
    if (isLegacyOnboardingToken(token)) {
      return getOnboardingView(token);
    }
    return null;
  }

  const invitation = await prisma.onboardingInvitation.findUnique({
    where: { jti: payload.jti },
    include: { existingClient: true },
  });
  if (!invitation) return null;
  if (invitation.expiresAt < new Date() && !invitation.usedAt) return null;

  return {
    emailMasked: maskEmail(invitation.email),
    existingClientId: invitation.existingClientId,
    existingType: invitation.existingClient?.type ?? null,
    displayName: invitation.existingClient?.displayName ?? null,
    completedAt: invitation.usedAt,
    brandName: await brandName(),
  };
}

/** Récupère les infos pré-remplies pour le formulaire d'onboarding legacy. */
export async function getOnboardingView(token: string): Promise<OnboardingView | null> {
  const invitation = await prisma.onboardingInvitation.findUnique({
    where: { token },
    include: { existingClient: true },
  });
  if (!invitation) return null;
  if (invitation.usedAt) {
    return {
      emailMasked: maskEmail(invitation.email),
      existingClientId: invitation.existingClientId,
      existingType: invitation.existingClient?.type ?? null,
      displayName: invitation.existingClient?.displayName ?? null,
      completedAt: invitation.usedAt,
      brandName: await brandName(),
    };
  }
  if (invitation.expiresAt < new Date()) return null;
  return {
    emailMasked: maskEmail(invitation.email),
    existingClientId: invitation.existingClientId,
    existingType: invitation.existingClient?.type ?? null,
    displayName: invitation.existingClient?.displayName ?? null,
    completedAt: null,
    brandName: await brandName(),
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
  siren?: string | null;
  apeCode?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  addressCityCode?: string | null;
  addressLat?: number | null;
  addressLon?: number | null;
  addressManualConfirmed?: boolean;
  notes?: string | null;
};

function buildDisplayName(d: OnboardingSubmission): string {
  if (d.type === "B2B") return (d.companyName ?? "").trim() || "Société";
  return [d.firstName?.trim(), d.lastName?.trim()].filter(Boolean).join(" ") || "Client";
}

async function toPrismaData(d: OnboardingSubmission) {
  const addr = await normalizeFrenchAddress({
    addressLine1: d.addressLine1,
    postalCode: d.postalCode,
    city: d.city,
    country: d.country,
    addressCityCode: d.addressCityCode,
    addressLat: d.addressLat,
    addressLon: d.addressLon,
    addressManualConfirmed: d.addressManualConfirmed,
  });
  if (!addr.ok) throw new AddressValidationError(addr.error);

  let siren = d.siren?.replace(/\s/g, "") || null;
  let siret = d.siret?.replace(/\s/g, "") || null;
  let apeCode = d.apeCode?.trim() || null;
  let companyName = d.companyName?.trim() || null;
  let companyVerifiedAt: Date | null = null;

  if (d.type === "B2B" && (siren || siret)) {
    const verified = await verifyCompanyIdentifiers({
      siren,
      siret,
      companyName,
      apeCode,
    });
    if (!verified.ok) throw new AddressValidationError(verified.error);
    siren = verified.data.siren;
    siret = verified.data.siret;
    apeCode = verified.data.apeCode;
    companyName = verified.data.companyName;
    companyVerifiedAt = verified.data.companyVerifiedAt;
  }

  return {
    type: d.type,
    displayName: buildDisplayName({ ...d, companyName }),
    firstName: d.firstName?.trim() || null,
    lastName: d.lastName?.trim() || null,
    companyName,
    emailEncrypted: encryptOptional(d.email || null),
    emailHash: computeEmailHash(d.email || null),
    phoneEncrypted: encryptOptional(d.phone || null),
    siretEncrypted: encryptOptional(siret),
    sirenEncrypted: encryptOptional(siren),
    apeCode,
    companyVerifiedAt,
    addressLine1: addr.address.addressLine1,
    addressLine2: d.addressLine2?.trim() || null,
    postalCode: addr.address.postalCode,
    city: addr.address.city,
    country: d.country?.trim() || "FRANCE",
    addressCityCode: addr.address.addressCityCode,
    addressLat: addr.address.addressLat,
    addressLon: addr.address.addressLon,
  };
}

async function applySubmission(
  invitation: {
    id: string;
    email: string;
    existingClientId: string | null;
  },
  data: OnboardingSubmission,
): Promise<{ ok: boolean; error?: string; alreadySubmitted?: boolean }> {
  if (data.type === "B2B" && !data.companyName?.trim()) {
    return { ok: false, error: "Raison sociale requise pour un professionnel" };
  }
  if (data.type === "B2C" && !data.lastName?.trim()) {
    return { ok: false, error: "Nom requis pour un particulier" };
  }

  const locked: OnboardingSubmission = { ...data, email: invitation.email };
  const now = new Date();

  try {
    if (invitation.existingClientId) {
      await prisma.client.update({
        where: { id: invitation.existingClientId },
        data: { ...(await toPrismaData(locked)), onboardingCompletedAt: now },
      });
      await prisma.onboardingInvitation.update({
        where: { id: invitation.id },
        data: { usedAt: now },
      });
      await issueAndSendAccessCode(invitation.existingClientId).catch((err) => {
        console.error(`[email] code suivi après onboarding (existant) échoué`, err);
      });
      return { ok: true };
    }

    const clientNumber = await allocateClientNumber();
    const created = await prisma.client.create({
      data: {
        ...(await toPrismaData(locked)),
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
  } catch (e) {
    if (e instanceof AddressValidationError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

/**
 * Soumission via token HMAC (formulaire Kouzia).
 * Idempotence : si déjà soumis → alreadySubmitted.
 */
export async function submitPublicClient(
  token: string,
  data: OnboardingSubmission,
): Promise<{ ok: boolean; error?: string; alreadySubmitted?: boolean }> {
  const payload = verifyOnboardingToken(token);
  if (!payload) {
    if (isLegacyOnboardingToken(token)) {
      return submitOnboarding(token, data);
    }
    return { ok: false, error: "Lien invalide ou expiré" };
  }

  const invitation = await prisma.onboardingInvitation.findUnique({
    where: { jti: payload.jti },
  });
  if (!invitation) return { ok: false, error: "Lien invalide ou expiré" };
  if (invitation.usedAt) {
    return { ok: false, error: "Ce formulaire a déjà été soumis.", alreadySubmitted: true };
  }
  if (invitation.expiresAt < new Date()) {
    return { ok: false, error: "Ce lien a expiré. Contactez-moi pour en recevoir un nouveau." };
  }

  return applySubmission(invitation, data);
}

/**
 * Valide et applique la soumission d'onboarding legacy (token hex).
 */
export async function submitOnboarding(
  token: string,
  data: OnboardingSubmission,
): Promise<{ ok: boolean; error?: string; alreadySubmitted?: boolean }> {
  const invitation = await prisma.onboardingInvitation.findUnique({
    where: { token },
  });
  if (!invitation) return { ok: false, error: "Lien invalide ou expiré" };
  if (invitation.usedAt) {
    return { ok: false, error: "Ce formulaire a déjà été soumis.", alreadySubmitted: true };
  }
  if (invitation.expiresAt < new Date()) {
    return { ok: false, error: "Ce lien a expiré. Contactez-moi pour en recevoir un nouveau." };
  }
  return applySubmission(invitation, data);
}

/** Conservé pour compat éventuelle (génération token legacy). */
export function generateLegacyOnboardingToken(): { token: string; expiresAt: Date } {
  const token = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + getOnboardingTtlDays() * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}
