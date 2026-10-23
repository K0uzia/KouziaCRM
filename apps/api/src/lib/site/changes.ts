import { createHash } from "node:crypto";
import { SiteItemStatus, SitePublicationStatus, type SiteFaq, type SiteProject, type SiteReference, type SiteReview } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, SITE_OPTIONAL_FILES, type SiteFileName, type SiteOptionalFileName } from "@/lib/site/contract.js";
import { faqOut, projectOut, referenceOut, reviewOut } from "@/lib/site/mapping.js";
import type { SiteSnapshot } from "@/lib/site/snapshot.js";
import { SITE_TEXT_SCHEMAS, type SiteTextKey } from "@/lib/site/texts.js";

/**
 * État de publication de chaque élément de l'espace Site, calculé dans l'ERP (sans GitHub) :
 * - draft : jamais publié, pas sur le site ;
 * - new : marqué « sur le site », jamais publié ;
 * - modified : publié, puis modifié (empreinte de la forme publiée différente) ;
 * - published : identique à la version publiée ;
 * - removal : publié, puis retiré ou repassé en brouillon : le retrait part à la prochaine publication ;
 * - withdrawn : retiré, et plus sur le site.
 * L'empreinte porte sur la forme écrite dans le dépôt du site (projectOut, faqOut…) : un changement sans effet sur
 * le site (accord, preuve, notes) ne rend pas un élément « Modifié ».
 */
export type PublicationState = "draft" | "new" | "modified" | "published" | "removal" | "withdrawn";
export type SiteCollection = "projects" | "reviews" | "references" | "faq";

/** Nombre de publications qui gardent leurs fichiers (filesJson) ; au-delà, vidé (quelques dizaines de Ko chacune). */
export const FILES_RETENTION = 50;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Row = { status: SiteItemStatus; publishedAt: Date | null; publishedHash: string | null };

/** Empreinte de la forme publiée d'un élément (ce que le dépôt du site recevrait). */
export function itemHash(collection: SiteCollection, row: SiteProject | SiteReview | SiteReference | SiteFaq): string {
  if (collection === "projects") return hash(projectOut(row as SiteProject));
  if (collection === "reviews") return hash(reviewOut(row as SiteReview));
  if (collection === "references") return hash(referenceOut(row as SiteReference));
  return hash(faqOut(row as SiteFaq));
}

export const textHash = (valueJson: string) => hash(JSON.parse(valueJson));

/** Sur le site à la prochaine publication : statut « sur le site » (et témoignage non écarté). */
function onSite(row: Row & { rejectedAt?: Date | null }) {
  return row.status === SiteItemStatus.PUBLISHED && !row.rejectedAt;
}

export function publicationState(row: Row & { rejectedAt?: Date | null }, currentHash: string): PublicationState {
  if (onSite(row)) {
    if (!row.publishedAt) return "new";
    // Publié avant le suivi par empreinte (sans publishedHash) : « publié » jusqu'à la publication suivante.
    return row.publishedHash && row.publishedHash !== currentHash ? "modified" : "published";
  }
  if (row.publishedHash) return "removal";
  return row.status === SiteItemStatus.WITHDRAWN ? "withdrawn" : "draft";
}

/** Changements qui partiront à la prochaine publication. */
export type PendingChange = {
  collection: SiteCollection | "texts" | "order";
  /** Identifiant de l'élément, clé du texte, ou nom du fichier pour un changement d'ordre. */
  id: string;
  label: string;
  state: "new" | "modified" | "removal" | "order";
  /** Écran où le changement se voit et se corrige. */
  to: string;
};

const TEXT_LABEL: Record<SiteTextKey, { label: string; to: string }> = {
  infos: { label: "Coordonnées et réseaux", to: "/site/tous-les-textes?page=global" },
  accroche: { label: "Accroche de l'accueil", to: "/site/tous-les-textes?page=accueil" },
  offres: { label: "Offres et tarifs", to: "/site/tous-les-textes?page=sitesWeb" },
  avisMethode: { label: "Méthode des témoignages", to: "/site/avis" },
  pages: { label: "Textes des pages", to: "/site/tous-les-textes?page=accueil" },
  seo: { label: "Référencement des pages", to: "/site/tous-les-textes?page=accueil" },
  "espace-client": { label: "Textes de l'espace client", to: "/site/tous-les-textes?page=espaceClient" },
  menus: { label: "Menus", to: "/site/tous-les-textes?page=global" },
};

const COLLECTION_FILE: Record<SiteCollection, SiteFileName> = {
  projects: "realisations",
  reviews: "avis",
  references: "references",
  faq: "faq",
};
const ORDER_LABEL: Partial<Record<SiteFileName, { label: string; to: string }>> = {
  realisations: { label: "Ordre des réalisations", to: "/site/realisations" },
  references: { label: "Ordre des références", to: "/site/references" },
  faq: { label: "Ordre des questions", to: "/site/faq" },
  avis: { label: "Ordre des témoignages", to: "/site/avis" },
};

const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Liste des changements à publier, calculée sans GitHub. `detailed` : faux si le contenu diffère de la dernière
 * publication sans qu'aucun changement ne soit identifiable (publication antérieure au suivi par empreinte).
 */
/** Fichiers de la dernière publication arrivée dans le dépôt (commit ou rien à changer), null si aucune n'est connue. */
export async function lastPublishedFiles(): Promise<Record<string, string> | null> {
  const last = await prisma.sitePublication.findFirst({
    where: { filesJson: { not: null }, OR: [{ commitSha: { not: null } }, { status: SitePublicationStatus.NOOP }] },
    orderBy: { startedAt: "desc" },
    select: { filesJson: true },
  });
  return last?.filesJson ? (JSON.parse(last.filesJson) as Record<string, string>) : null;
}

/**
 * Identifiant publié de la page projet d'une réalisation dans les fichiers d'une publication : la réalisation y figure
 * avec son détail (page /realisations/<id>/). null : pas de publication connue, réalisation absente ou carte seule.
 */
export function publishedProjectPage(files: Record<string, string> | null, slug: string): string | null {
  if (!files?.realisations) return null;
  try {
    const list = (JSON.parse(files.realisations) as { realisations?: Array<{ id?: unknown; detail?: unknown }> }).realisations ?? [];
    return list.some((r) => r.id === slug && r.detail) ? slug : null;
  } catch {
    return null;
  }
}

export async function pendingChanges(snapshot: SiteSnapshot): Promise<{ changes: PendingChange[]; lastFiles: Record<string, string> | null }> {
  const [projects, reviews, references, faq, texts, lastFiles] = await Promise.all([
    prisma.siteProject.findMany(),
    prisma.siteReview.findMany(),
    prisma.siteReference.findMany(),
    prisma.siteFaq.findMany(),
    prisma.siteText.findMany(),
    lastPublishedFiles(),
  ]);
  const changes: PendingChange[] = [];
  const touched = new Set<SiteFileName>();
  const add = (collection: SiteCollection, id: string, label: string, state: PublicationState, to: string) => {
    if (state !== "new" && state !== "modified" && state !== "removal") return;
    changes.push({ collection, id, label, state, to });
    touched.add(COLLECTION_FILE[collection]);
  };
  for (const p of projects) add("projects", p.id, p.name, publicationState(p, itemHash("projects", p)), `/site/realisations/${p.id}`);
  for (const r of reviews) add("reviews", r.id, `Témoignage de ${r.author}`, publicationState(r, itemHash("reviews", r)), `/site/avis/${r.id}`);
  for (const r of references) add("references", r.id, r.name, publicationState(r, itemHash("references", r)), `/site/references/${r.id}`);
  for (const f of faq) add("faq", f.id, short(f.question), publicationState(f, itemHash("faq", f)), `/site/faq/${f.id}`);
  for (const t of texts) {
    const key = t.key as SiteTextKey;
    if (!Object.hasOwn(SITE_TEXT_SCHEMAS, key) || !t.publishedHash || t.publishedHash === textHash(t.valueJson)) continue;
    changes.push({ collection: "texts", id: key, label: TEXT_LABEL[key].label, state: "modified", to: TEXT_LABEL[key].to });
    touched.add(key === "infos" ? "infos" : key === "avisMethode" ? "avis" : "textes");
  }
  // Fichier différent de la version publiée sans élément changé : seul l'ordre a bougé.
  if (lastFiles) {
    for (const name of SITE_FILES) {
      const order = ORDER_LABEL[name];
      if (order && !touched.has(name) && lastFiles[name] !== undefined && lastFiles[name] !== snapshot.files[name]) {
        changes.push({ collection: "order", id: name, label: order.label, state: "order", to: order.to });
      }
    }
  }
  return { changes, lastFiles };
}

/**
 * Après une publication arrivée dans le dépôt (commit poussé ou NOOP) : chaque élément lu avant l'instantané
 * (updatedAt antérieur à readAt) prend l'empreinte de sa forme publiée et, s'il n'en avait pas, sa date de
 * publication (identifiant figé, suppression refusée) ; un élément retiré perd la sienne. Les fichiers publiés sont
 * gardés sur la publication (filesJson), dans la limite de FILES_RETENTION publications.
 */
export async function recordPublished(readAt: Date, snapshot: SiteSnapshot, publicationId: string): Promise<void> {
  const at = new Date();
  const before = { updatedAt: { lte: readAt } };
  const [projects, reviews, references, faq, texts] = await Promise.all([
    prisma.siteProject.findMany({ where: before }),
    prisma.siteReview.findMany({ where: before }),
    prisma.siteReference.findMany({ where: before }),
    prisma.siteFaq.findMany({ where: before }),
    prisma.siteText.findMany({ where: before }),
  ]);
  const writes: Promise<unknown>[] = [];
  /** Ce qui change pour un élément : empreinte (et date) s'il est sur le site, empreinte effacée s'il en est retiré. */
  const change = (collection: SiteCollection, row: Row & { rejectedAt?: Date | null }) => {
    if (!onSite(row)) return row.publishedHash ? { publishedHash: null } : null;
    const h = itemHash(collection, row as never);
    return row.publishedHash !== h || !row.publishedAt ? { publishedHash: h, publishedAt: row.publishedAt ?? at } : null;
  };
  for (const r of projects) {
    const data = change("projects", r);
    if (data) writes.push(prisma.siteProject.update({ where: { id: r.id }, data }));
  }
  for (const r of reviews) {
    const data = change("reviews", r);
    if (data) writes.push(prisma.siteReview.update({ where: { id: r.id }, data }));
  }
  for (const r of references) {
    const data = change("references", r);
    if (data) writes.push(prisma.siteReference.update({ where: { id: r.id }, data }));
  }
  for (const r of faq) {
    const data = change("faq", r);
    if (data) writes.push(prisma.siteFaq.update({ where: { id: r.id }, data }));
  }
  for (const t of texts) {
    // Document d'un fichier facultatif que le contrat du site ne permettait pas encore : rien n'est parti.
    if ((SITE_OPTIONAL_FILES as readonly string[]).includes(t.key) && snapshot.files[t.key as SiteOptionalFileName] === undefined) continue;
    const h = textHash(t.valueJson);
    if (t.publishedHash !== h) writes.push(prisma.siteText.update({ where: { key: t.key }, data: { publishedHash: h } }));
  }
  await Promise.all(writes);
  await prisma.sitePublication.update({ where: { id: publicationId }, data: { filesJson: JSON.stringify(snapshot.files) } });
  // Rétention : seules les FILES_RETENTION publications les plus récentes gardent leurs fichiers.
  const kept = await prisma.sitePublication.findMany({
    where: { filesJson: { not: null } },
    orderBy: { startedAt: "desc" },
    skip: FILES_RETENTION,
    select: { id: true },
  });
  if (kept.length) await prisma.sitePublication.updateMany({ where: { id: { in: kept.map((k) => k.id) } }, data: { filesJson: null } });
}
