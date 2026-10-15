import { SiteItemStatus, type Client, type SiteReview } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { isOrganization } from "@/lib/clients/client-type.js";

/**
 * Témoignages déposés par les clients depuis leur espace (/suivi), en fin de projet (statut DONE).
 * Un par projet, modifiable tant qu'il n'est pas publié, retirable à tout moment. Ils arrivent « À valider »
 * dans l'ERP (SiteReview, source CLIENT_SPACE) ; Kouzia publie le texte tel quel ou l'écarte avec un motif.
 * La preuve d'accord (version et texte de l'accord, session, IP, navigateur) est chiffrée ; IP et
 * navigateur sont purgés 3 ans après le retrait ou l'écartement (purgeTestimonialProofs).
 */

export const TESTIMONIAL_SOURCE = "CLIENT_SPACE";
export const TESTIMONIAL_MAX_LENGTH = 600;
/** Version du texte d'accord : à changer avec le texte, l'ancienne n'est plus acceptée. */
export const CONSENT_VERSION = "2026-10-15";
export const CONSENT_TEXT =
  "J'accepte que ce témoignage soit publié sur kouzia.com, sans modification, avec le nom affiché choisi ci-dessus. Je peux le modifier avant sa publication et demander son retrait à tout moment depuis mon espace client.";
export const PROOF_RETENTION_MS = 3 * 365.25 * 24 * 60 * 60 * 1000;

/** Forme du nom (format convenu avec KouziaWebsite, /suivi) : « Marie D. », « Marie Dupont », nom de la structure. */
export const AUTHOR_FORMATS = ["INITIAL", "FULL", "ORGANIZATION"] as const;
export type AuthorFormat = (typeof AUTHOR_FORMATS)[number];
export type TestimonialState = "NONE" | "PENDING" | "PUBLISHED" | "REJECTED" | "WITHDRAWN";

/** Codes d'erreur stables, traduits par le site (aucun message brut affiché dans /suivi). */
export type TestimonialErrorCode = "NOT_FOUND" | "NOT_ELIGIBLE" | "ALREADY_PUBLISHED" | "NAME_MODE_INVALID" | "NONE";

export class TestimonialError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: TestimonialErrorCode,
  ) {
    super(message);
  }
}

/** Formes du nom proposées au client, calculées depuis sa fiche (jamais saisies librement). */
export function nameOptions(client: Pick<Client, "type" | "displayName" | "firstName" | "lastName" | "companyName">) {
  const out: Partial<Record<AuthorFormat, string>> = {};
  const words = client.displayName.trim().split(/\s+/);
  const first = client.firstName?.trim() || (isOrganization(client.type) ? "" : (words[0] ?? ""));
  const last = client.lastName?.trim() || (isOrganization(client.type) ? "" : words.slice(1).join(" "));
  if (first && last) {
    out.INITIAL = `${first} ${last.charAt(0).toLocaleUpperCase("fr")}.`;
    out.FULL = `${first} ${last}`;
  } else if (first) {
    out.FULL = first;
  }
  if (isOrganization(client.type)) out.ORGANIZATION = client.companyName?.trim() || client.displayName.trim();
  return out;
}

export function testimonialState(row: Pick<SiteReview, "status" | "rejectedAt"> | null): TestimonialState {
  if (!row) return "NONE";
  if (row.rejectedAt) return "REJECTED";
  if (row.status === SiteItemStatus.WITHDRAWN) return "WITHDRAWN";
  if (row.status === SiteItemStatus.PUBLISHED) return "PUBLISHED";
  return "PENDING";
}

/** Date du jour (AAAA-MM-JJ) en heure de Paris. */
const parisDate = (d: Date) => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(d);

/** État du témoignage de chaque projet terminé du client, pour /suivi. */
export async function portalTestimonials(clientId: string) {
  const rows = await prisma.siteReview.findMany({
    where: { clientId, source: TESTIMONIAL_SOURCE, projectId: { not: null } },
    select: {
      projectId: true,
      status: true,
      rejectedAt: true,
      rejectionReason: true,
      text: true,
      authorFormat: true,
      consentAt: true,
      publishedAt: true,
    },
  });
  return new Map(
    rows.map((r) => [
      r.projectId!,
      {
        status: testimonialState(r),
        text: r.text,
        nameMode: r.authorFormat as AuthorFormat | null,
        submittedAt: r.consentAt?.toISOString() ?? null,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        // Écarté : le motif est donné à l'auteur (D111-19), ici comme par e-mail.
        ...(r.rejectedAt ? { rejectionReason: r.rejectionReason } : {}),
      },
    ]),
  );
}

type Submission = {
  client: Client;
  sessionId: string;
  projectId: string;
  text: string;
  authorFormat: AuthorFormat;
  ip: string;
  userAgent: string | null;
};

async function ownDoneProject(clientId: string, projectId: string) {
  const project = await prisma.clientProject.findFirst({ where: { id: projectId, clientId, visibleOnPortal: true } });
  // Projet d'un autre client ou inconnu : même réponse (rien ne révèle l'existence d'un projet d'autrui).
  if (!project) throw new TestimonialError("Projet introuvable.", 404, "NOT_FOUND");
  return project;
}

/** Dépôt ou modification (tant que non publié). L'accord est recoché et la preuve renouvelée à chaque envoi. */
export async function submitTestimonial(s: Submission, now = new Date()): Promise<SiteReview> {
  const project = await ownDoneProject(s.client.id, s.projectId);
  if (project.status !== "DONE") throw new TestimonialError("Le témoignage s'ouvre quand le projet est terminé.", 403, "NOT_ELIGIBLE");
  const author = nameOptions(s.client)[s.authorFormat];
  if (!author) throw new TestimonialError("Forme du nom indisponible pour ce compte.", 400, "NAME_MODE_INVALID");

  const existing = await prisma.siteReview.findUnique({ where: { projectId: project.id } });
  if (existing && (existing.publishedAt || existing.status === SiteItemStatus.PUBLISHED)) {
    throw new TestimonialError("Témoignage déjà publié : il ne se modifie plus. Vous pouvez demander son retrait.", 409, "ALREADY_PUBLISHED");
  }
  const proof = encrypt(
    JSON.stringify({
      consentVersion: CONSENT_VERSION,
      consentText: CONSENT_TEXT,
      portalSessionId: s.sessionId,
      ip: s.ip,
      userAgent: s.userAgent?.slice(0, 400) ?? null,
      at: now.toISOString(),
    }),
  );
  const data = {
    source: TESTIMONIAL_SOURCE,
    clientId: s.client.id,
    author,
    authorFormat: s.authorFormat,
    text: s.text,
    reviewedOn: parisDate(now),
    consentAt: now,
    consentChannel: "Espace client",
    consentProofEncrypted: proof,
    // Renvoyé après un écartement ou un retrait non publié : de nouveau à valider.
    status: SiteItemStatus.DRAFT,
    rejectedAt: null,
    rejectionReason: null,
    withdrawalRequestedAt: null,
  };
  if (existing) return prisma.siteReview.update({ where: { id: existing.id }, data });
  return prisma.siteReview.create({
    data: {
      ...data,
      projectId: project.id,
      // Date de l'expérience : fin du projet (invitation envoyée au passage à « Terminé »), sinon le dépôt ; modifiable dans l'ERP.
      experienceOn: parisDate(project.reviewInviteSentAt ?? now),
      position: 0,
    },
  });
}

/**
 * Retrait demandé par le client. Jamais mis en ligne : le témoignage et sa preuve sont effacés.
 * Déjà publié : statut Retiré (sorti du site à la prochaine publication), preuve gardée jusqu'à la purge.
 */
export async function withdrawTestimonial(clientId: string, projectId: string, now = new Date()): Promise<"deleted" | "withdrawn"> {
  await ownDoneProject(clientId, projectId);
  const row = await prisma.siteReview.findUnique({ where: { projectId } });
  if (!row || row.clientId !== clientId) throw new TestimonialError("Aucun témoignage pour ce projet.", 404, "NONE");
  if (!row.publishedAt) {
    await prisma.siteReview.delete({ where: { id: row.id } });
    return "deleted";
  }
  await prisma.siteReview.update({
    where: { id: row.id },
    data: { status: SiteItemStatus.WITHDRAWN, withdrawalRequestedAt: row.withdrawalRequestedAt ?? now },
  });
  return "withdrawn";
}

/**
 * Purge de l'IP et du navigateur de la preuve, 3 ans après le retrait ou l'écartement (la date et la
 * version de l'accord restent). Renvoie le nombre de preuves allégées.
 */
export async function purgeTestimonialProofs(now = new Date()): Promise<number> {
  const limit = new Date(now.getTime() - PROOF_RETENTION_MS);
  const rows = await prisma.siteReview.findMany({
    where: {
      source: TESTIMONIAL_SOURCE,
      consentProofEncrypted: { not: null },
      OR: [{ rejectedAt: { lt: limit } }, { status: SiteItemStatus.WITHDRAWN, withdrawalRequestedAt: { lt: limit } }],
    },
    select: { id: true, consentProofEncrypted: true },
  });
  let purged = 0;
  for (const r of rows) {
    let proof: Record<string, unknown>;
    try {
      proof = JSON.parse(decrypt(r.consentProofEncrypted!)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!("ip" in proof) && !("userAgent" in proof)) continue;
    delete proof.ip;
    delete proof.userAgent;
    await prisma.siteReview.update({ where: { id: r.id }, data: { consentProofEncrypted: encrypt(JSON.stringify(proof)) } });
    purged++;
  }
  return purged;
}
