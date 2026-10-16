import { createHash } from "node:crypto";
import { Prisma, SitePublicationStatus, type SitePublication } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, type SiteIssue } from "@/lib/site/contract.js";
import { buildSiteSnapshot, type SiteSnapshot } from "@/lib/site/snapshot.js";
import { readSiteMedia } from "@/lib/site/media.js";
import { recordPublished } from "@/lib/site/changes.js";
import { purgePreviousVersions } from "@/lib/site/library.js";
import { GithubError, githubJson, readRepoFileAt, SITE_CONTENT_DIR, siteBranch, siteRepo } from "@/lib/site/github.js";

/**
 * Publication du contenu du site : un seul commit Git Data sur la branche du site, avec les fichiers modifiés
 * seulement (JSON et images de l'ERP). Ce push lance le workflow du site (deploy.yml), qui construit le site et
 * pousse la branche deploy ; le webhook Git de hPanel l'installe chez Hostinger. Suivi : état du run de ce
 * commit (jeton avec Actions en lecture), puis kouzia.com/version.json (« En ligne » quand il montre le commit).
 * Le repository_dispatch de l'ancienne voie (rsync) ne part que si SITE_DEPLOY_DISPATCH=true.
 */

const LOCK = "RUNNING";
/** Publication bloquée au-delà (API arrêtée en cours de route) : le verrou est libéré. */
export const PUBLICATION_STALE_MS = 15 * 60_000;
/** Délai entre le lancement du déploiement et la mise en ligne constatée sur version.json. */
export const PUBLICATION_LIVE_TIMEOUT_MS = 10 * 60_000;
const COMMIT_ATTEMPTS = 3;
const MEDIA_DIR = "public/media";
/** Seules les images publiées par l'ERP sont supprimables : le reste de public/ appartient au site. */
const ERP_MEDIA_FILE = /^public\/media\/[a-f0-9]{12}((-2x)?\.webp|\.jpg)$/;
const FOLLOWED = [SitePublicationStatus.DISPATCHED, SitePublicationStatus.BUILDING, SitePublicationStatus.DEPLOYED];

/** Workflow du site lancé par le push sur sa branche (construction, puis branche deploy installée par hPanel). */
export const siteDeployWorkflow = () => process.env.SITE_DEPLOY_WORKFLOW?.trim() || "deploy.yml";
/** Ancienne voie : Action lancée par repository_dispatch « publication-site ». Désactivée par défaut. */
const dispatchEnabled = () => process.env.SITE_DEPLOY_DISPATCH?.trim() === "true";

/** Messages du suivi, affichés tels quels par l'écran. */
export const DEPLOY_MESSAGES = {
  building: "Construction en cours",
  hosting: "Mise en ligne par Hostinger…",
  live: "En ligne",
  buildFailed: "Échec de la construction : voir le run.",
  notLive: "Pas en ligne après 10 min : vérifier le déploiement Git de hPanel.",
} as const;

/** label : ce que montre une image de l'ERP (« capture de « Nom » »), connu à l'ajout et au remplacement. */
export type FileChange = { path: string; change: "added" | "modified" | "deleted"; label?: string };

export class PublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: SiteIssue[] = [],
  ) {
    super(message);
  }
}

/** Identifiant de blob Git d'un contenu : comparé à l'arbre du dépôt sans rien télécharger. */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

type Desired = Map<string, { content: Buffer; sha: string; label?: string }>;
type TreeEntry = { path: string; type: string; sha: string };

async function desiredFiles(snapshot: SiteSnapshot): Promise<Desired> {
  const desired: Desired = new Map();
  const put = (path: string, content: Buffer, label?: string) => desired.set(path, { content, sha: gitBlobSha(content), label });
  for (const name of SITE_FILES) put(`${SITE_CONTENT_DIR}/${name}.json`, Buffer.from(snapshot.files[name], "utf8"));
  for (const sha12 of snapshot.media) {
    const ext = snapshot.mediaExt[sha12] ?? "webp";
    const x1 = await readSiteMedia(sha12, false, ext);
    if (!x1) throw new PublishError(`Image ${sha12} absente du disque de l'ERP.`, 422);
    put(`${MEDIA_DIR}/${sha12}.${ext}`, x1, snapshot.mediaNames[sha12]);
    // Image de partage (JPEG) : une seule taille.
    const x2 = ext === "webp" ? await readSiteMedia(sha12, true) : null;
    if (x2) put(`${MEDIA_DIR}/${sha12}-2x.webp`, x2, snapshot.mediaNames[sha12]);
  }
  return desired;
}

/** Écart entre l'arbre du dépôt et ce que l'ERP publie, trié par chemin. */
export function diffTree(tree: TreeEntry[], desired: Desired): FileChange[] {
  const existing = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const changes: FileChange[] = [];
  for (const [path, file] of desired) {
    const sha = existing.get(path);
    const label = file.label ? { label: file.label } : {};
    if (!sha) changes.push({ path, change: "added", ...label });
    else if (sha !== file.sha) changes.push({ path, change: "modified", ...label });
  }
  for (const path of existing.keys()) {
    if (ERP_MEDIA_FILE.test(path) && !desired.has(path)) changes.push({ path, change: "deleted" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

type RepoState = { headSha: string; treeSha: string; tree: TreeEntry[] };

async function readRepoState(): Promise<RepoState> {
  const repo = siteRepo();
  const ref = await githubJson<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${siteBranch()}`);
  const commit = await githubJson<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = await githubJson<{ tree: TreeEntry[]; truncated?: boolean }>(
    "GET",
    `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
  );
  if (tree.truncated) throw new PublishError("Arbre du dépôt du site trop grand pour être comparé.", 502);
  return { headSha: ref.object.sha, treeSha: commit.tree.sha, tree: tree.tree };
}

type Plan = { state: RepoState; snapshot: SiteSnapshot; desired: Desired; changes: FileChange[] };

/** Instantané validé contre le contrat lu au commit de tête, et écart avec le dépôt. */
async function plan(): Promise<Plan> {
  const state = await readRepoState();
  let contract: unknown;
  try {
    contract = JSON.parse(await readRepoFileAt(`${SITE_CONTENT_DIR}/contenu.schema.json`, state.headSha));
  } catch (e) {
    if (e instanceof GithubError) throw e;
    throw new PublishError("Contrat du site (contenu.schema.json) illisible.", 502);
  }
  const snapshot = await buildSiteSnapshot(contract);
  if (snapshot.issues.length) {
    throw new PublishError("Le contrôle avant publication a relevé des anomalies.", 422, snapshot.issues);
  }
  const desired = await desiredFiles(snapshot);
  return { state, snapshot, desired, changes: diffTree(state.tree, desired) };
}

export type PublicationPreview = { headSha: string; digest: string; changes: FileChange[]; lines: string[] };

/** Ce que publierait un clic sur « Publier », sans rien écrire. */
export async function previewPublication(): Promise<PublicationPreview> {
  const p = await plan();
  return { headSha: p.state.headSha, digest: p.snapshot.digest, changes: p.changes, lines: changeLines(p.changes) };
}

/** Rubrique de chaque fichier de contenu, dans le récapitulatif, l'historique et le message de commit. */
export const FILE_LABEL: Record<string, string> = {
  "infos.json": "Coordonnées",
  "textes.json": "Accroche et offres",
  "faq.json": "FAQ",
  "realisations.json": "Réalisations",
  "avis.json": "Témoignages",
  "references.json": "Références",
};
const CHANGE_LABEL: Record<FileChange["change"], string> = { added: "ajouté", modified: "modifié", deleted: "retiré" };
const IMAGE_VERB: Record<FileChange["change"], string> = { added: "ajoutée", modified: "remplacée", deleted: "retirée" };

/**
 * Lignes lisibles d'une publication : « FAQ : modifié », « Image ajoutée : capture de « Nom » ». La version
 * 2x suit la 1x ; une image sans nom connu (retirée, plus citée) est comptée : « 2 images retirées ».
 * Les rubriques de contenu viennent d'abord, les images ensuite.
 */
export function changeLines(changes: FileChange[]): string[] {
  const lines: string[] = [];
  const images: string[] = [];
  const unnamed: Record<FileChange["change"], number> = { added: 0, modified: 0, deleted: 0 };
  for (const c of changes) {
    if (c.path.startsWith(`${SITE_CONTENT_DIR}/`)) {
      const name = c.path.slice(SITE_CONTENT_DIR.length + 1);
      lines.push(`${FILE_LABEL[name] ?? name} : ${CHANGE_LABEL[c.change]}`);
    } else if (!c.path.endsWith("-2x.webp")) {
      if (c.label) images.push(`Image ${IMAGE_VERB[c.change]} : ${c.label}`);
      else unnamed[c.change]++;
    }
  }
  for (const change of ["added", "modified", "deleted"] as const) {
    const n = unnamed[change];
    if (n) images.push(`${n} image${n > 1 ? "s" : ""} ${IMAGE_VERB[change]}${n > 1 ? "s" : ""}`);
  }
  return [...lines, ...images];
}

/** Résumé sur une ligne, pour le message de commit et l'historique. */
export const describeChanges = (changes: FileChange[]): string => changeLines(changes).join(" ; ");

/** Libère le verrou d'une publication restée en cours (API arrêtée pendant la publication). */
export async function expireStalePublications(now = new Date()): Promise<void> {
  await prisma.sitePublication.updateMany({
    where: { lock: LOCK, startedAt: { lt: new Date(now.getTime() - PUBLICATION_STALE_MS) } },
    data: { lock: null, status: SitePublicationStatus.FAILED, error: "Publication interrompue (délai dépassé).", finishedAt: now },
  });
}

const fail = (id: string, error: string) =>
  prisma.sitePublication.update({
    where: { id },
    data: { status: SitePublicationStatus.FAILED, error, lock: null, finishedAt: new Date() },
  });

/**
 * Publie : verrou (une seule publication à la fois), commit unique sur la branche du site (3 essais si
 * elle a bougé entre-temps), puis déclenchement du déploiement. Aucun écart : NOOP, aucun commit.
 */
/** Contenu arrivé dans le dépôt : empreintes et fichiers publiés enregistrés, anciennes versions d'images retirées. */
async function afterPublished(readAt: Date, snapshot: SiteSnapshot, publicationId: string): Promise<void> {
  await recordPublished(readAt, snapshot, publicationId);
  // Ménage seulement : un échec ici n'annule pas une publication réussie.
  await purgePreviousVersions().catch((e) => console.error("[site] Ménage des anciennes images impossible :", e instanceof Error ? e.message : e));
}

export async function publishSite(): Promise<SitePublication> {
  await expireStalePublications();
  let row: SitePublication;
  try {
    row = await prisma.sitePublication.create({ data: { lock: LOCK, digest: "", summaryJson: "[]" } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new PublishError("Une publication est déjà en cours.", 409);
    }
    throw e;
  }

  const repo = siteRepo();
  const created = new Set<string>();
  let commitSha: string | null = null;
  let p: Plan | null = null;
  let readAt = new Date();
  try {
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS && !commitSha; attempt++) {
      readAt = new Date();
      p = await plan();
      if (!p.changes.length) {
        // Dépôt déjà identique au contenu saisi : ce qui est marqué « sur le site » y est bien.
        await afterPublished(readAt, p.snapshot, row.id);
        return await prisma.sitePublication.update({
          where: { id: row.id },
          data: {
            status: SitePublicationStatus.NOOP,
            digest: p.snapshot.digest,
            baseSha: p.state.headSha,
            lock: null,
            finishedAt: new Date(),
          },
        });
      }
      row = await prisma.sitePublication.update({
        where: { id: row.id },
        data: { digest: p.snapshot.digest, summaryJson: JSON.stringify(p.changes), baseSha: p.state.headSha },
      });
      // Un blob ne dépend pas du parent : créé une seule fois, même si la branche a bougé.
      for (const c of p.changes) {
        const file = p.desired.get(c.path);
        if (!file || created.has(file.sha)) continue;
        await githubJson("POST", `/repos/${repo}/git/blobs`, { content: file.content.toString("base64"), encoding: "base64" });
        created.add(file.sha);
      }
      const tree = await githubJson<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
        base_tree: p.state.treeSha,
        tree: p.changes.map((c) => ({ path: c.path, mode: "100644", type: "blob", sha: c.change === "deleted" ? null : p!.desired.get(c.path)!.sha })),
      });
      const commit = await githubJson<{ sha: string }>("POST", `/repos/${repo}/git/commits`, {
        message: `Contenu publié depuis l'ERP : ${describeChanges(p.changes)}`,
        tree: tree.sha,
        parents: [p.state.headSha],
      });
      try {
        await githubJson("PATCH", `/repos/${repo}/git/refs/heads/${siteBranch()}`, { sha: commit.sha, force: false });
        commitSha = commit.sha;
      } catch (e) {
        // La branche a avancé (commit du site entre la lecture et l'écriture) : nouvel essai sur le nouveau parent.
        if (e instanceof GithubError && (e.status === 409 || e.status === 422) && attempt < COMMIT_ATTEMPTS) continue;
        throw e;
      }
    }
    if (!commitSha) throw new PublishError("La branche du site a bougé pendant chaque essai : publication abandonnée.", 409);
    row = await prisma.sitePublication.update({
      where: { id: row.id },
      data: { status: SitePublicationStatus.COMMITTED, commitSha },
    });
    // Contenu dans le dépôt dès le commit poussé, même si le déploiement échoue ensuite (il se relance depuis l'Action).
    await afterPublished(readAt, p!.snapshot, row.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Publication impossible.";
    await fail(row.id, message);
    if (e instanceof PublishError || e instanceof GithubError) throw e;
    throw new PublishError(message, 500);
  }

  // Le push sur la branche du site lance déjà sa construction (deploy.yml) : rien d'autre à déclencher,
  // sauf l'ancienne voie par repository_dispatch si elle est demandée.
  if (dispatchEnabled()) {
    try {
      await githubJson("POST", `/repos/${repo}/dispatches`, { event_type: "publication-site", client_payload: { sha: commitSha } });
    } catch (e) {
      const detail = e instanceof Error ? e.message : "erreur inconnue";
      return fail(
        row.id,
        `Contenu enregistré dans le dépôt (commit ${commitSha.slice(0, 7)}), mais déploiement non déclenché : ${detail} Le lancer depuis l'Action du site.`,
      );
    }
  }
  return prisma.sitePublication.update({
    where: { id: row.id },
    data: { status: SitePublicationStatus.DISPATCHED, dispatchedAt: new Date() },
  });
}

// --- Suivi du déploiement ---------------------------------------------------------------------

// « non-configure » : secrets Hostinger absents côté GitHub. « ignore » : ancien nom, envoyé par les runs antérieurs
// à ce résultat (envoi sauté, secrets absents ou étape précédente en échec).
export const DEPLOY_RESULTS = ["deploye", "simulation", "echec", "non-configure", "ignore", "refuse"] as const;
export type DeployResult = (typeof DEPLOY_RESULTS)[number];

const RESULT_ERROR: Partial<Record<DeployResult, string>> = {
  echec: DEPLOY_MESSAGES.buildFailed,
  refuse: "L'Action du site a refusé ce commit.",
  "non-configure":
    "Déploiement non configuré : le contenu est dans le dépôt, mais GitHub n'a pas les accès Hostinger. Voir le guide docs/deploiement-hostinger.md du site.",
  ignore: "Déploiement non lancé : accès Hostinger absents ou étape précédente en échec (voir le run de l'Action).",
};

/**
 * Rappel signé de l'Action. Renvoie « duplicate » pour une livraison déjà reçue (anti-rejeu durable),
 * « unknown » si aucune publication suivie ne porte ce sha (journalisé, sans effet).
 */
export async function recordDeployEvent(event: {
  deliveryId: string;
  sha: string;
  result: DeployResult;
  runUrl: string | null;
}): Promise<"duplicate" | "unknown" | "applied"> {
  const publication =
    event.sha === "invalide"
      ? null
      : await prisma.sitePublication.findFirst({ where: { commitSha: event.sha }, orderBy: { startedAt: "desc" } });
  try {
    await prisma.siteDeployEvent.create({
      data: { deliveryId: event.deliveryId, sha: event.sha, result: event.result, runUrl: event.runUrl, publicationId: publication?.id ?? null },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "duplicate";
    throw e;
  }
  if (!publication || !FOLLOWED.includes(publication.status as (typeof FOLLOWED)[number]) || publication.error) return "unknown";
  if (event.result === "simulation") return "unknown";
  const runUrl = event.runUrl ?? publication.runUrl;
  if (event.result === "deploye") {
    await prisma.sitePublication.update({
      where: { id: publication.id },
      data: { status: SitePublicationStatus.DEPLOYED, runUrl, lock: null },
    });
  } else {
    await prisma.sitePublication.update({
      where: { id: publication.id },
      data: { status: SitePublicationStatus.FAILED, runUrl, error: RESULT_ERROR[event.result]!, lock: null, finishedAt: new Date() },
    });
  }
  return "applied";
}

export const sitePublicUrl = () => (process.env.SITE_PUBLIC_URL?.trim() || "https://kouzia.com").replace(/\/$/, "");

async function onlineSha(): Promise<string | null> {
  try {
    const res = await fetch(`${sitePublicUrl()}/version.json?t=${Date.now()}`, {
      headers: { "Cache-Control": "no-cache", "User-Agent": "kouzia-erp" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sha?: unknown };
    return typeof body.sha === "string" ? body.sha : null;
  } catch {
    return null;
  }
}

type Run = { html_url: string; head_sha: string; status: string; conclusion: string | null; created_at: string };

/**
 * Le commit en ligne contient-il celui de la publication ? Une publication plus récente (ou un commit du site)
 * peut être en ligne à sa place : son contenu y est. Comparaison GitHub, mémorisée pour un passage du suivi.
 */
async function contains(online: string, published: string, memo: Map<string, boolean>): Promise<boolean> {
  if (online === published) return true;
  const key = `${published}...${online}`;
  if (!memo.has(key)) {
    try {
      const { status } = await githubJson<{ status: string }>("GET", `/repos/${siteRepo()}/compare/${published}...${online}`);
      memo.set(key, status === "ahead" || status === "identical");
    } catch {
      memo.set(key, false);
    }
  }
  return memo.get(key)!;
}

/**
 * Run du workflow de déploiement pour ce commit (le plus récent). Jeton sans Actions en lecture, ou GitHub
 * indisponible : null, le suivi passe alors par version.json seul.
 */
async function findRun(p: SitePublication): Promise<Run | null> {
  const path = dispatchEnabled()
    ? `/repos/${siteRepo()}/actions/runs?event=repository_dispatch&per_page=10`
    : `/repos/${siteRepo()}/actions/workflows/${encodeURIComponent(siteDeployWorkflow())}/runs?head_sha=${p.commitSha}&per_page=5`;
  try {
    const { workflow_runs: runs } = await githubJson<{ workflow_runs: Run[] }>("GET", path);
    const since = (p.dispatchedAt ?? p.startedAt).getTime() - 60_000;
    return runs.find((r) => r.head_sha === p.commitSha && new Date(r.created_at).getTime() >= since) ?? null;
  } catch {
    return null;
  }
}

/**
 * Tâche du worker (toutes les 15 s) : verrous périmés, état du run de construction, mise en ligne constatée
 * sur version.json, et abandon du suivi au-delà de 10 minutes. Le rappel signé de l'Action reste accepté
 * (recordDeployEvent) mais n'est plus attendu.
 */
export async function followSitePublications(now = new Date()): Promise<void> {
  await expireStalePublications(now);
  const rows = await prisma.sitePublication.findMany({
    where: { status: { in: FOLLOWED }, liveAt: null, error: null, commitSha: { not: null } },
  });
  if (!rows.length) return;
  const live = await onlineSha();
  const memo = new Map<string, boolean>();
  for (const p of rows) {
    if (live && (await contains(live, p.commitSha!, memo))) {
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.LIVE, liveAt: now, finishedAt: now, lock: null },
      });
      continue;
    }
    const started = (p.dispatchedAt ?? p.startedAt).getTime();
    if (now.getTime() - started > PUBLICATION_LIVE_TIMEOUT_MS) {
      // Le contenu est dans le dépôt, mais kouzia.com ne montre pas ce commit : hPanel n'a pas installé la branche deploy.
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.FAILED, error: DEPLOY_MESSAGES.notLive, lock: null, finishedAt: now },
      });
      continue;
    }
    // Construction terminée : plus rien à demander à GitHub, seul version.json peut encore conclure.
    if (p.status === SitePublicationStatus.DEPLOYED) continue;
    const run = await findRun(p);
    if (!run) continue;
    if (run.status === "completed" && run.conclusion === "cancelled") {
      // Run en attente remplacé par celui d'une publication plus récente, qui contient celle-ci (concurrency du
      // workflow) : pas un échec. version.json conclura quand il montrera un commit qui la contient.
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.BUILDING, runUrl: run.html_url, lock: null },
      });
    } else if (run.status === "completed" && run.conclusion !== "success") {
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.FAILED, runUrl: run.html_url, error: DEPLOY_MESSAGES.buildFailed, lock: null, finishedAt: now },
      });
    } else if (run.status === "completed") {
      // Branche deploy poussée : hPanel l'installe. Verrou libéré, une autre publication est possible.
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.DEPLOYED, runUrl: run.html_url, lock: null },
      });
    } else if (p.status === SitePublicationStatus.DISPATCHED || p.runUrl !== run.html_url) {
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.BUILDING, runUrl: run.html_url },
      });
    }
  }
}

export const publicationOut = (p: SitePublication) => {
  const changes = JSON.parse(p.summaryJson) as FileChange[];
  const watching = FOLLOWED.includes(p.status as (typeof FOLLOWED)[number]) && !p.error && !p.liveAt;
  return {
    id: p.id,
    status: p.status,
    /** Verrou pris : une autre publication est refusée. */
    running: p.lock === LOCK,
    /** Déploiement encore suivi (l'écran se rafraîchit tant que c'est vrai). */
    watching,
    /** Étape en cours, en clair : construction, mise en ligne par Hostinger, en ligne. */
    phase: p.liveAt
      ? DEPLOY_MESSAGES.live
      : watching
        ? p.status === SitePublicationStatus.DEPLOYED
          ? DEPLOY_MESSAGES.hosting
          : DEPLOY_MESSAGES.building
        : null,
    changes,
    lines: changeLines(changes),
    summary: describeChanges(changes),
    digest: p.digest,
    baseSha: p.baseSha,
    commitSha: p.commitSha,
    commitUrl: p.commitSha ? `https://github.com/${siteRepo()}/commit/${p.commitSha}` : null,
    runUrl: p.runUrl,
    error: p.error,
    startedAt: p.startedAt,
    dispatchedAt: p.dispatchedAt,
    finishedAt: p.finishedAt,
    liveAt: p.liveAt,
  };
};
