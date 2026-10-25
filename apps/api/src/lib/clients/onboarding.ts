import { isOrganization, type ClientTypeValue } from "@/lib/clients/client-type.js";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { encrypt, encryptOptional } from "@/lib/crypto.js";
import { invitationEmail } from "@/lib/privacy/at-rest.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { allocateClientNumber } from "@/lib/clients/numbering.js";
import { sendPortalWelcomeEmail } from "@/lib/clients/access-email.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import {
  createOnboardingToken,
  getOnboardingTtlDays,
  isLegacyOnboardingToken,
  verifyOnboardingToken,
} from "@/lib/clients/onboarding-token.js";
import {
  type AddressErrorCode,
  type AddressSuggestion,
  type CompanyErrorCode,
  normalizeFrenchAddress,
  verifyCompanyIdentifiers,
} from "@/lib/address/france.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { syncPrimaryContact } from "@/lib/clients/contacts.js";
import { AddressValidationError } from "@/lib/clients.js";
import { maskEmail } from "@/lib/portal/auth.js";
import { templateText } from "@/lib/email/template-registry.js";

/** Bienvenue envoyée d'office après la fiche remplie : file « E-mails à valider » (famille portal_access), le client attend. */
const WELCOME_REVIEW = { family: "portal_access", origin: "CLIENT_ACTION", clientWaiting: true } as const;

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
 * Envoie l'email contenant le lien Kouzia /nouveau-client/?token=...
 */
/** Lien personnel de l'invitation dans le brouillon : créé seulement à l'envoi, à cet endroit du texte. */
export const INVITE_LINK_PLACEHOLDER = "{{lien}}";
/** Texte relu : le lien remplace {{lien}} ; retiré par mégarde, il est ajouté en fin de message (sans lui, rien ne sert). */
export function withInviteLink(text: string, link: string): string {
  const t = text.trim();
  return t.includes(INVITE_LINK_PLACEHOLDER) ? t.replaceAll(INVITE_LINK_PLACEHOLDER, link) : `${t}\n\n${link}`;
}

async function inviteContent(existingClientId: string | null, link: string) {
  const company = await getCompanySettings();
  const brand = company.tradeName ?? company.legalName;
  const ttl = getOnboardingTtlDays();
  const request = existingClientId
    ? "Pour mettre à jour vos informations de facturation, merci de compléter le formulaire sécurisé ci-dessous :"
    : "Pour me permettre de vous facturer dans les meilleures conditions, j'ai besoin de quelques informations vous concernant. Merci de prendre 2 minutes pour compléter votre fiche via le lien sécurisé ci-dessous :";
  const validity = `Ce lien est personnel et expire dans ${ttl} jours. Vos données sont transmises directement à ${brand} et ne sont pas conservées sur le site public.`;
  const object = existingClientId ? "Mise à jour de votre fiche client" : "Complétez votre fiche client";
  // Modèle modifié dans Réglages (M3c) : le lien personnel et sa validité restent des blocs fixes.
  const content = await templateText(
    "onboarding.invite",
    { salutation: "Bonjour,", marque: brand, objet_invitation: object, demande: request, lien: link, bloc_validite: validity },
    { subject: `${object} - ${brand}`, body: ["Bonjour,", "", request, "", link, "", validity].join("\n") },
  );
  // Signature des Réglages, comme les autres e-mails (défaut : « Cordialement, » et le nom commercial).
  const text = [content.body, "", formatPlainTextSignature(company, buildEmailBrand(company))].join("\n");
  return { subject: content.subject, text };
}

/** « Vérifier l'e-mail » : l'invitation telle qu'elle partirait, avec {{lien}} à la place du lien personnel. */
export async function onboardingInviteDraft(email: string, existingClientId: string | null) {
  const { subject, text } = await inviteContent(existingClientId, INVITE_LINK_PLACEHOLDER);
  return { to: email.trim().toLowerCase(), subject, text, attachments: [] as string[] };
}

export async function sendOnboardingInvite(opts: {
  email: string;
  existingClientId?: string | null;
  /** Objet et texte relus dans « Vérifier l'e-mail » ({{lien}} remplacé par le lien personnel). */
  subject?: string;
  text?: string;
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
      // Adresse chiffrée au repos ; l'ancienne colonne en clair reste vide.
      email: "",
      emailEncrypted: encrypt(email),
      token: jti,
      jti,
      expiresAt,
      existingClientId: opts.existingClientId ?? null,
    },
  });

  if (!(await isSmtpConfigured())) return { ok: true, sent: false, reason: "smtp_off", token };

  try {
    const link = `${publicSiteOrigin()}/nouveau-client/?token=${encodeURIComponent(token)}`;
    const content = await inviteContent(opts.existingClientId ?? null, link);
    const body = opts.text?.trim() ? withInviteLink(opts.text, link) : content.text;
    const subject = opts.subject?.trim() || content.subject;
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
    // Adresse masquée : jamais de donnée personnelle en clair dans les journaux.
    console.error(`[email] envoi invitation onboarding échoué pour ${maskEmail(email)}`, err);
    return { ok: true, sent: false, reason: "error", token };
  }
}

export type OnboardingView = {
  emailMasked: string;
  existingClientId: string | null;
  existingType: ClientTypeValue | null;
  displayName: string | null;
  completedAt: Date | null;
  brandName: string | null;
};


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
    emailMasked: maskEmail(invitationEmail(invitation)),
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
      emailMasked: maskEmail(invitationEmail(invitation)),
      existingClientId: invitation.existingClientId,
      existingType: invitation.existingClient?.type ?? null,
      displayName: invitation.existingClient?.displayName ?? null,
      completedAt: invitation.usedAt,
      brandName: await brandName(),
    };
  }
  if (invitation.expiresAt < new Date()) return null;
  return {
    emailMasked: maskEmail(invitationEmail(invitation)),
    existingClientId: invitation.existingClientId,
    existingType: invitation.existingClient?.type ?? null,
    displayName: invitation.existingClient?.displayName ?? null,
    completedAt: null,
    brandName: await brandName(),
  };
}

export type OnboardingSubmission = {
  type: ClientTypeValue;
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
  if (isOrganization(d.type)) return (d.companyName ?? "").trim() || (d.type === "ASSOCIATION" ? "Association" : "Société");
  return [d.firstName?.trim(), d.lastName?.trim()].filter(Boolean).join(" ") || "Client";
}

/** Réponse d'une soumission ; code et suggestion : refus d'adresse (contrat dans le README, section API publique). */
export type SubmissionResult = {
  ok: boolean;
  error?: string;
  alreadySubmitted?: boolean;
  code?: AddressErrorCode | CompanyErrorCode;
  suggestion?: AddressSuggestion;
};

/** Le message commence par « Adresse » : l'ancien site le reconnaît ainsi et propose de confirmer la saisie. */
export function publicSuggestionMessage(s: AddressSuggestion): string {
  return `Adresse à vérifier : la base nationale propose « ${s.addressLine1}, ${s.postalCode} ${s.city} ». Choisissez cette adresse ou confirmez votre saisie.`;
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
  }, { rejectOtherStreet: true });
  if (!addr.ok) {
    const message = addr.suggestion ? publicSuggestionMessage(addr.suggestion) : addr.error;
    throw new AddressValidationError(message, { code: addr.code, ...(addr.suggestion ? { suggestion: addr.suggestion } : {}) });
  }

  let siren = d.siren?.replace(/\s/g, "") || null;
  let siret = d.siret?.replace(/\s/g, "") || null;
  let apeCode = d.apeCode?.trim() || null;
  let companyName = d.companyName?.trim() || null;
  let companyVerifiedAt: Date | null = null;

  if (isOrganization(d.type) && (siren || siret)) {
    const verified = await verifyCompanyIdentifiers({
      siren,
      siret,
      companyName,
      apeCode,
    });
    if (!verified.ok) throw new AddressValidationError(verified.error, { code: verified.code });
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
    emailEncrypted: string | null;
    existingClientId: string | null;
  },
  data: OnboardingSubmission,
): Promise<SubmissionResult> {
  if (isOrganization(data.type) && !data.companyName?.trim()) {
    return {
      ok: false,
      error: data.type === "ASSOCIATION" ? "Nom de l'association requis" : "Raison sociale requise pour un professionnel",
    };
  }
  if (data.type === "B2C" && !data.lastName?.trim()) {
    return { ok: false, error: "Nom requis pour un particulier" };
  }

  const locked: OnboardingSubmission = { ...data, email: invitationEmail(invitation) };
  const now = new Date();

  try {
    if (invitation.existingClientId) {
      const before = await prisma.client.findUnique({ where: { id: invitation.existingClientId }, select: { emailHash: true } });
      const updated = await prisma.client.update({
        where: { id: invitation.existingClientId },
        data: { ...(await toPrismaData(locked)), onboardingCompletedAt: now },
        select: { emailHash: true },
      });
      // Adresse remplacée par celle de l'invitation : les accès ouverts avec l'ancienne adresse sont fermés.
      if (before && before.emailHash !== updated.emailHash) {
        const { endPortalAccessAfterEmailChange } = await import("@/lib/portal/auth.js");
        await endPortalAccessAfterEmailChange(invitation.existingClientId);
      }
      await syncPrimaryContact(invitation.existingClientId);
      await prisma.onboardingInvitation.update({
        where: { id: invitation.id },
        data: { usedAt: now },
      });
      await sendPortalWelcomeEmail(invitation.existingClientId, {}, WELCOME_REVIEW).catch((err) => {
        console.error(`[email] accès espace client après onboarding (existant) échoué`, err);
      });
      return { ok: true };
    }

    const clientNumber = await allocateClientNumber();
    const created = await prisma.client.create({
      data: {
        ...(await toPrismaData(locked)),
        clientNumber,
        onboardingCompletedAt: now,
      },
    });
    await syncPrimaryContact(created.id);
    await prisma.onboardingInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: now, createdClientId: created.id },
    });
    await sendPortalWelcomeEmail(created.id, {}, WELCOME_REVIEW).catch((err) => {
      console.error(`[email] accès espace client après onboarding (nouveau) échoué`, err);
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof AddressValidationError) {
      return { ok: false, error: e.message, ...e.detail };
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
): Promise<SubmissionResult> {
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
): Promise<SubmissionResult> {
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
