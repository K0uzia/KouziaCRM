import { createHash } from "node:crypto";
import { Prisma, SitePublicationStatus, type SitePublication } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, type SiteIssue } from "@/lib/site/contract.js";
import { buildSiteSnapshot, type SiteSnapshot } from "@/lib/site/snapshot.js";
import { readSiteMedia } from "@/lib/site/media.js";
import { GithubError, githubJson, readRepoFileAt, SITE_CONTENT_DIR, siteBranch, siteRepo } from "@/lib/site/github.js";

/**
 * Publication du contenu du site (lot E3) : un seul commit Git Data sur la branche du site, avec les
 * fichiers modifiés seulement (JSON et images de l'ERP), puis repository_dispatch « publication-site »
 * vers l'Action de déploiement. Suivi : rappel signé (webhook), sinon sondage des runs, puis version.json.
 */

const LOCK = "RUNNING";
/** Publication bloquée au-delà (API arrêtée en cours de route) : le verrou est libéré. */
export const PUBLICATION_STALE_MS = 15 * 60_000;
/** Délai entre le lancement du déploiement et la mise en ligne constatée sur version.json. */
export const PUBLICATION_LIVE_TIMEOUT_MS = 10 * 60_000;
const COMMIT_ATTEMPTS = 3;
const MEDIA_DIR = "public/media";
/** Seules les images publiées par l'ERP sont supprimables : le reste de public/ appartient au site. */
const ERP_MEDIA_FILE = /^public\/media\/[a-f0-9]{12}(-2x)?\.webp$/;
const FOLLOWED = [SitePublicationStatus.DISPATCHED, SitePublicationStatus.BUILDING, SitePublicationStatus.DEPLOYED];

export type FileChange = { path: string; change: "added" | "modified" | "deleted" };

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

type Desired = Map<string, { content: Buffer; sha: string }>;
type TreeEntry = { path: string; type: string; sha: string };

async function desiredFiles(snapshot: SiteSnapshot): Promise<Desired> {
  const desired: Desired = new Map();
  const put = (path: string, content: Buffer) => desired.set(path, { content, sha: gitBlobSha(content) });
  for (const name of SITE_FILES) put(`${SITE_CONTENT_DIR}/${name}.json`, Buffer.from(snapshot.files[name], "utf8"));
  for (const sha12 of snapshot.media) {
    const x1 = await readSiteMedia(sha12);
    if (!x1) throw new PublishError(`Image ${sha12} absente du disque de l'ERP.`, 422);
    put(`${MEDIA_DIR}/${sha12}.webp`, x1);
    const x2 = await readSiteMedia(sha12, true);
    if (x2) put(`${MEDIA_DIR}/${sha12}-2x.webp`, x2);
  }
  return desired;
}

/** Écart entre l'arbre du dépôt et ce que l'ERP publie, trié par chemin. */
export function diffTree(tree: TreeEntry[], desired: Desired): FileChange[] {
  const existing = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  const changes: FileChange[] = [];
  for (const [path, file] of desired) {
    const sha = existing.get(path);
    if (!sha) changes.push({ path, change: "added" });
    else if (sha !== file.sha) changes.push({ path, change: "modified" });
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

export type PublicationPreview = { headSha: string; digest: string; changes: FileChange[] };

/** Ce que publierait un clic sur « Publier », sans rien écrire. */
export async function previewPublication(): Promise<PublicationPreview> {
  const p = await plan();
  return { headSha: p.state.headSha, digest: p.snapshot.digest, changes: p.changes };
}

/** Résumé lisible pour le message de commit et l'historique. */
export function describeChanges(changes: FileChange[]): string {
  const content = changes.filter((c) => c.path.startsWith(`${SITE_CONTENT_DIR}/`)).map((c) => c.path.slice(SITE_CONTENT_DIR.length + 1));
  const media = changes.filter((c) => c.path.startsWith(`${MEDIA_DIR}/`) && !c.path.endsWith("-2x.webp"));
  const parts: string[] = [];
  if (content.length) parts.push(content.join(", "));
  const added = media.filter((c) => c.change === "added").length;
  const removed = media.filter((c) => c.change === "deleted").length;
  const modified = media.length - added - removed;
  if (added) parts.push(`${added} image${added > 1 ? "s" : ""} ajoutée${added > 1 ? "s" : ""}`);
  if (modified) parts.push(`${modified} image${modified > 1 ? "s" : ""} remplacée${modified > 1 ? "s" : ""}`);
  if (removed) parts.push(`${removed} image${removed > 1 ? "s" : ""} retirée${removed > 1 ? "s" : ""}`);
  return parts.join(" ; ");
}

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
  try {
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS && !commitSha; attempt++) {
      p = await plan();
      if (!p.changes.length) {
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
  } catch (e) {
    const message = e instanceof Error ? e.message : "Publication impossible.";
    await fail(row.id, message);
    if (e instanceof PublishError || e instanceof GithubError) throw e;
    throw new PublishError(message, 500);
  }

  try {
    await githubJson("POST", `/repos/${repo}/dispatches`, { event_type: "publication-site", client_payload: { sha: commitSha } });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "erreur inconnue";
    return fail(
      row.id,
      `Contenu enregistré dans le dépôt (commit ${commitSha.slice(0, 7)}), mais déploiement non déclenché : ${detail} Le lancer depuis l'Action du site.`,
    );
  }
  return prisma.sitePublication.update({
    where: { id: row.id },
    data: { status: SitePublicationStatus.DISPATCHED, dispatchedAt: new Date() },
  });
}

// --- Suivi du déploiement ---------------------------------------------------------------------

export const DEPLOY_RESULTS = ["deploye", "simulation", "echec", "ignore", "refuse"] as const;
export type DeployResult = (typeof DEPLOY_RESULTS)[number];

const RESULT_ERROR: Partial<Record<DeployResult, string>> = {
  echec: "Le déploiement a échoué (voir le run de l'Action).",
  refuse: "L'Action du site a refusé ce commit.",
  ignore: "Déploiement non lancé : secrets Hostinger absents dans le dépôt du site.",
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

/** Run de l'Action lancé par ce dispatch (secours quand aucun rappel n'arrive). */
async function findRun(p: SitePublication): Promise<Run | null> {
  try {
    const { workflow_runs: runs } = await githubJson<{ workflow_runs: Run[] }>(
      "GET",
      `/repos/${siteRepo()}/actions/runs?event=repository_dispatch&per_page=10`,
    );
    const since = (p.dispatchedAt ?? p.startedAt).getTime() - 60_000;
    return runs.find((r) => r.head_sha === p.commitSha && new Date(r.created_at).getTime() >= since) ?? null;
  } catch {
    return null;
  }
}

/**
 * Tâche du worker (toutes les 15 s) : verrous périmés, état du run si le rappel tarde, mise en ligne
 * constatée sur version.json, et abandon du suivi au-delà de 10 minutes.
 */
export async function followSitePublications(now = new Date()): Promise<void> {
  await expireStalePublications(now);
  const rows = await prisma.sitePublication.findMany({
    where: { status: { in: FOLLOWED }, liveAt: null, error: null, commitSha: { not: null } },
  });
  if (!rows.length) return;
  const live = await onlineSha();
  for (const p of rows) {
    if (live && live === p.commitSha) {
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.LIVE, liveAt: now, finishedAt: now, lock: null },
      });
      continue;
    }
    const started = (p.dispatchedAt ?? p.startedAt).getTime();
    if (now.getTime() - started > PUBLICATION_LIVE_TIMEOUT_MS) {
      const deployed = p.status === SitePublicationStatus.DEPLOYED;
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: {
          // Déployé selon l'Action mais absent de version.json : on garde l'état, avec l'alerte.
          status: deployed ? p.status : SitePublicationStatus.FAILED,
          error: deployed
            ? "Déployé selon l'Action, mais kouzia.com/version.json ne montre pas ce commit après 10 minutes."
            : "Pas en ligne 10 minutes après le lancement du déploiement (voir l'Action du site).",
          lock: null,
          finishedAt: now,
        },
      });
      continue;
    }
    if (p.status === SitePublicationStatus.DEPLOYED) continue;
    const run = await findRun(p);
    if (!run) continue;
    if (run.status === "completed" && run.conclusion !== "success") {
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.FAILED, runUrl: run.html_url, error: RESULT_ERROR.echec!, lock: null, finishedAt: now },
      });
    } else if (p.status === SitePublicationStatus.DISPATCHED || p.runUrl !== run.html_url) {
      await prisma.sitePublication.update({
        where: { id: p.id },
        data: { status: SitePublicationStatus.BUILDING, runUrl: run.html_url },
      });
    }
  }
}

export const publicationOut = (p: SitePublication) => ({
  id: p.id,
  status: p.status,
  /** Publication ou déploiement encore suivi (l'écran se rafraîchit tant que c'est vrai). */
  running: p.lock === LOCK || (FOLLOWED.includes(p.status as (typeof FOLLOWED)[number]) && !p.error && !p.liveAt),
  changes: JSON.parse(p.summaryJson) as FileChange[],
  summary: describeChanges(JSON.parse(p.summaryJson) as FileChange[]),
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
});
