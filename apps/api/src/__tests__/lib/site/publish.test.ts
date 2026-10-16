import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SiteMediaKind, SitePublicationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { encrypt } from "@/lib/crypto.js";
import { SITE_FILES, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { siteMediaRelativePath } from "@/lib/site/media.js";
import {
  DEPLOY_MESSAGES,
  changeLines,
  diffTree,
  followSitePublications,
  publicationOut,
  gitBlobSha,
  publishSite,
  PUBLICATION_LIVE_TIMEOUT_MS,
  PUBLICATION_STALE_MS,
} from "@/lib/site/publish.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`).replace(/\r\n/g, "\n")])) as Record<SiteFileName, string>;
const SECRET = "secret-de-rappel-de-test";
const REPO = "https://api.github.com/repos/K0uzia/KouziaWebsite";
const sha = (c: string) => c.repeat(40);

/** Faux GitHub : une branche, un arbre (chemin -> sha de blob), les écritures journalisées. */
type Fake = {
  head: string;
  tree: Map<string, string>;
  conflicts: number;
  blobs: string[];
  trees: { base_tree: string; tree: { path: string; sha: string | null }[] }[];
  commits: { message: string; parents: string[] }[];
  dispatches: unknown[];
  runs: { html_url: string; head_sha: string; status: string; conclusion: string | null; created_at: string }[];
  /** Statut des routes Actions (403 : jeton sans Actions en lecture). */
  actionsStatus: number;
  /** « ancien>récent » : le commit récent contient l'ancien (route compare). */
  descendants: Set<string>;
  online: string | null;
  dispatchStatus: number;
};
let fake: Fake;
let commitCounter = 0;

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFake() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.startsWith("https://kouzia.com/version.json")) {
        return fake.online ? json({ sha: fake.online, construitLe: new Date().toISOString() }) : new Response("", { status: 404 });
      }
      if (!url.startsWith(REPO)) throw new Error(`appel inattendu : ${url}`);
      const p = url.slice(REPO.length);
      if (method === "GET" && p === "/git/ref/heads/main") return json({ object: { sha: fake.head } });
      if (method === "GET" && p.startsWith("/git/commits/")) return json({ tree: { sha: `tree-${p.slice(13)}` } });
      if (method === "GET" && p.startsWith("/git/trees/")) {
        return json({ tree: [...fake.tree].map(([path, s]) => ({ path, type: "blob", sha: s })), truncated: false });
      }
      if (method === "GET" && p.startsWith("/contents/src/content/site/contenu.schema.json")) {
        return new Response(fixture("contenu.schema.json"), { status: 200 });
      }
      if (method === "POST" && p === "/git/blobs") {
        const s = gitBlobSha(Buffer.from(body.content, "base64"));
        fake.blobs.push(s);
        return json({ sha: s }, 201);
      }
      if (method === "POST" && p === "/git/trees") {
        fake.trees.push(body);
        return json({ sha: `newtree-${fake.trees.length}` }, 201);
      }
      if (method === "POST" && p === "/git/commits") {
        fake.commits.push(body);
        commitCounter += 1;
        return json({ sha: commitCounter.toString(16).padStart(40, "c") }, 201);
      }
      if (method === "PATCH" && p === "/git/refs/heads/main") {
        if (body.force !== false) throw new Error("force doit valoir false");
        if (fake.conflicts > 0) {
          fake.conflicts -= 1;
          fake.head = sha("e"); // un commit du site est arrivé entre-temps
          return json({ message: "Update is not a fast forward" }, 422);
        }
        fake.head = body.sha;
        return json({ object: { sha: body.sha } });
      }
      if (method === "POST" && p === "/dispatches") {
        fake.dispatches.push(body);
        return new Response(null, { status: fake.dispatchStatus });
      }
      if (method === "GET" && p.startsWith("/actions/")) {
        if (fake.actionsStatus !== 200) return json({ message: "Resource not accessible by personal access token" }, fake.actionsStatus);
        if (p.startsWith("/actions/runs")) return json({ workflow_runs: fake.runs });
        const m = p.match(/^\/actions\/workflows\/deploy\.yml\/runs\?head_sha=([0-9a-f]{40})/);
        if (m) return json({ workflow_runs: fake.runs.filter((x) => x.head_sha === m[1]) });
      }
      const cmp = method === "GET" ? p.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/) : null;
      if (cmp) return json({ status: fake.descendants.has(`${cmp[1]}>${cmp[2]}`) ? "ahead" : "diverged" });
      throw new Error(`route GitHub non simulée : ${method} ${p}`);
    }),
  );
}

/** Dépôt identique au contenu importé (fichiers réels du site). */
function repoMatchingFixtures(): Map<string, string> {
  const tree = new Map<string, string>();
  for (const n of SITE_FILES) tree.set(`src/content/site/${n}.json`, gitBlobSha(Buffer.from(raw[n], "utf8")));
  tree.set("src/content/site/contenu.schema.json", sha("1"));
  tree.set("public/projets/morlaix.webp", sha("2"));
  return tree;
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { githubTokenEncrypted: encrypt("github_pat_test"), githubTokenHint: "••••test" } });
  invalidateCompanySettingsCache();
  await importSiteFiles(raw);
  fake = {
    head: sha("a"),
    tree: repoMatchingFixtures(),
    conflicts: 0,
    blobs: [],
    trees: [],
    commits: [],
    dispatches: [],
    runs: [],
    online: sha("a"),
    dispatchStatus: 204,
    actionsStatus: 200,
    descendants: new Set(),
  };
  installFake();
});
afterEach(() => {
  delete process.env.SITE_DEPLOY_DISPATCH;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("publication du site (Git Data)", () => {
  it("dépôt déjà à jour : NOOP, aucun commit ni déploiement", async () => {
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.NOOP);
    expect(p.lock).toBeNull();
    expect(fake.commits).toHaveLength(0);
    expect(fake.dispatches).toHaveLength(0);
  });

  it("élément créé dans l'ERP puis publié : publishedAt renseigné (identifiant figé), brouillon intact", async () => {
    const publiee = await prisma.siteFaq.create({
      data: { page: "HOME", position: 99, status: "PUBLISHED", question: "Question créée dans l'ERP ?", answer: "Réponse créée dans l'ERP." },
    });
    const brouillon = await prisma.siteFaq.create({
      data: { page: "HOME", position: 100, status: "DRAFT", question: "Question en brouillon ?", answer: "Pas encore sur le site." },
    });
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.DISPATCHED);
    expect((await prisma.siteFaq.findUniqueOrThrow({ where: { id: publiee.id } })).publishedAt).toBeInstanceOf(Date);
    expect((await prisma.siteFaq.findUniqueOrThrow({ where: { id: brouillon.id } })).publishedAt).toBeNull();
  });

  it("ancienne voie (SITE_DEPLOY_DISPATCH=true), dispatch en échec : le commit est poussé, l'élément est quand même marqué publié", async () => {
    process.env.SITE_DEPLOY_DISPATCH = "true";
    fake.dispatchStatus = 500;
    const q = await prisma.siteFaq.create({
      data: { page: "HOME", position: 99, status: "PUBLISHED", question: "Question ajoutée ?", answer: "Réponse ajoutée." },
    });
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.FAILED);
    expect(p.commitSha).toBeTruthy();
    expect((await prisma.siteFaq.findUniqueOrThrow({ where: { id: q.id } })).publishedAt).toBeInstanceOf(Date);
  });

  it("dépôt déjà à jour (NOOP) : un élément « sur le site » sans date de publication est marqué publié", async () => {
    const q = await prisma.siteFaq.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteFaq.update({ where: { id: q.id }, data: { publishedAt: null } });
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.NOOP);
    expect((await prisma.siteFaq.findUniqueOrThrow({ where: { id: q.id } })).publishedAt).toBeInstanceOf(Date);
  });

  it("un seul commit avec les seuls fichiers modifiés ; le push lance la construction, aucun repository_dispatch", async () => {
    const q = await prisma.siteFaq.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Réponse revue pour le test." } });
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.DISPATCHED);
    expect(fake.commits).toHaveLength(1);
    expect(fake.commits[0]!.parents).toEqual([sha("a")]);
    expect(fake.commits[0]!.message).toBe("Contenu publié depuis l'ERP : FAQ : modifié");
    expect(fake.trees[0]!.base_tree).toBe(`tree-${sha("a")}`);
    expect(fake.trees[0]!.tree.map((t) => t.path)).toEqual(["src/content/site/faq.json"]);
    expect(fake.dispatches).toEqual([]);
    expect(p.lock).toBe("RUNNING");
    expect(publicationOut(p)).toMatchObject({ watching: true, phase: DEPLOY_MESSAGES.building });
  });

  it("images de l'ERP ajoutées (1x et 2x), image orpheline supprimée, fichiers du site intacts", async () => {
    const sha12 = "abcdef012345";
    for (const x2 of [false, true]) {
      const abs = issuedPdfAbsolutePath(siteMediaRelativePath(sha12, x2));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(`image ${x2 ? "2x" : "1x"}`));
    }
    await prisma.siteMedia.create({ data: { sha12, kind: SiteMediaKind.CAPTURE, width: 960, height: 540, bytes: 8, width2x: 1920, height2x: 1080, bytes2x: 8 } });
    const project = await prisma.siteProject.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteProject.update({ where: { id: project.id }, data: { imagePath: `/media/${sha12}.webp` } });
    fake.tree.set("public/media/000000000000.webp", sha("3"));

    const p = await publishSite();
    const changed = Object.fromEntries(fake.trees[0]!.tree.map((t) => [t.path, t.sha]));
    expect(Object.keys(changed).sort()).toEqual(
      ["public/media/000000000000.webp", `public/media/${sha12}-2x.webp`, `public/media/${sha12}.webp`, "src/content/site/realisations.json"].sort(),
    );
    expect(changed["public/media/000000000000.webp"]).toBeNull();
    expect(changed).not.toHaveProperty("public/projets/morlaix.webp");
    expect(fake.blobs).toHaveLength(3);
    expect(fake.commits[0]!.message).toBe(
      `Contenu publié depuis l'ERP : Réalisations : modifié ; Image ajoutée : capture de « ${project.name} » ; 1 image retirée`,
    );
    // Historique : mêmes libellés que le message de commit.
    expect(publicationOut(p).lines).toEqual(["Réalisations : modifié", `Image ajoutée : capture de « ${project.name} »`, "1 image retirée"]);
    expect(p.status).toBe(SitePublicationStatus.DISPATCHED);
  });

  it("la branche a bougé : nouvel arbre sur le nouveau parent, blobs non renvoyés", async () => {
    await prisma.siteText.deleteMany({ where: { key: "avisMethode" } });
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Autre réponse." } });
    fake.conflicts = 1;
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.DISPATCHED);
    expect(fake.commits.map((c) => c.parents[0])).toEqual([sha("a"), sha("e")]);
    expect(fake.trees.map((t) => t.base_tree)).toEqual([`tree-${sha("a")}`, `tree-${sha("e")}`]);
    expect(new Set(fake.blobs).size).toBe(fake.blobs.length);
    expect(p.baseSha).toBe(sha("e"));
  });

  it("trois conflits de suite : échec propre, verrou libéré", async () => {
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Encore une réponse." } });
    fake.conflicts = 3;
    await expect(publishSite()).rejects.toMatchObject({ status: 422 });
    const row = await prisma.sitePublication.findFirstOrThrow();
    expect([row.status, row.lock]).toEqual([SitePublicationStatus.FAILED, null]);
    expect(fake.dispatches).toHaveLength(0);
  });

  it("anomalie avant publication : refus 422 avec la liste, rien n'est écrit ni gardé", async () => {
    await prisma.siteText.deleteMany({ where: { key: "accroche" } });
    await expect(publishSite()).rejects.toMatchObject({ status: 422, issues: expect.arrayContaining([expect.objectContaining({ file: "textes" })]) });
    expect(fake.commits).toHaveLength(0);
    expect(await prisma.sitePublication.findFirst({ where: { lock: "RUNNING" } })).toBeNull();
  });

  it("verrou : une seule publication à la fois ; un verrou de plus de 15 minutes est libéré", async () => {
    const stuck = await prisma.sitePublication.create({ data: { lock: "RUNNING", digest: "", summaryJson: "[]" } });
    await expect(publishSite()).rejects.toMatchObject({ status: 409 });
    await prisma.sitePublication.update({ where: { id: stuck.id }, data: { startedAt: new Date(Date.now() - PUBLICATION_STALE_MS - 1000) } });
    expect((await publishSite()).status).toBe(SitePublicationStatus.NOOP);
    expect((await prisma.sitePublication.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe(SitePublicationStatus.FAILED);
  });

  it("ancienne voie (SITE_DEPLOY_DISPATCH=true) : dispatch avec le sha ; refusé : commit gardé, échec avec la consigne", async () => {
    process.env.SITE_DEPLOY_DISPATCH = "true";
    const ok = await prisma.siteFaq.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteFaq.update({ where: { id: ok.id }, data: { answer: "Réponse publiée par l'ancienne voie." } });
    const premiere = await publishSite();
    expect(fake.dispatches).toEqual([{ event_type: "publication-site", client_payload: { sha: premiere.commitSha } }]);
    await prisma.sitePublication.update({ where: { id: premiere.id }, data: { lock: null } });
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Réponse." } });
    fake.dispatchStatus = 403;
    const p = await publishSite();
    expect(p.status).toBe(SitePublicationStatus.FAILED);
    expect(p.commitSha).toBeTruthy();
    expect(p.error).toMatch(/déploiement non déclenché/);
    expect(p.lock).toBeNull();
  });
});

describe("changeLines", () => {
  it("rubriques du contenu d'abord, images nommées ensuite, 2x regroupée, images sans nom comptées", () => {
    expect(
      changeLines([
        { path: "public/media/aaaaaaaaaaaa-2x.webp", change: "modified", label: "logo de « Ulamir »" },
        { path: "public/media/aaaaaaaaaaaa.webp", change: "modified", label: "logo de « Ulamir »" },
        { path: "public/media/bbbbbbbbbbbb.webp", change: "deleted" },
        { path: "public/media/cccccccccccc.webp", change: "deleted" },
        { path: "src/content/site/avis.json", change: "modified" },
        { path: "src/content/site/infos.json", change: "modified" },
      ]),
    ).toEqual(["Témoignages : modifié", "Coordonnées : modifié", "Image remplacée : logo de « Ulamir »", "2 images retirées"]);
  });
});

describe("diffTree", () => {
  it("ne supprime que les images publiées par l'ERP", () => {
    const changes = diffTree(
      [
        { path: "public/media/abcdef012345.webp", type: "blob", sha: sha("1") },
        { path: "public/media/logo-maison.webp", type: "blob", sha: sha("2") },
        { path: "public/projets/a.webp", type: "blob", sha: sha("3") },
      ],
      new Map(),
    );
    expect(changes).toEqual([{ path: "public/media/abcdef012345.webp", change: "deleted" }]);
  });
});

describe("suivi du déploiement", () => {
  async function dispatched() {
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: `Réponse ${Math.random()}` } });
    return publishSite();
  }

  it("run en cours : BUILDING avec le lien ; version.json au bon sha : LIVE, verrou libéré", async () => {
    const p = await dispatched();
    fake.runs = [{ html_url: "https://github.com/K0uzia/KouziaWebsite/actions/runs/42", head_sha: p.commitSha!, status: "in_progress", conclusion: null, created_at: new Date().toISOString() }];
    await followSitePublications();
    let row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.runUrl]).toEqual([SitePublicationStatus.BUILDING, "https://github.com/K0uzia/KouziaWebsite/actions/runs/42"]);
    fake.online = p.commitSha;
    await followSitePublications();
    row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.lock, Boolean(row.liveAt)]).toEqual([SitePublicationStatus.LIVE, null, true]);
  });

  it("construction en échec : FAILED, « Échec de la construction : voir le run. » avec le lien", async () => {
    const p = await dispatched();
    fake.runs = [{ html_url: "https://github.com/K0uzia/KouziaWebsite/actions/runs/43", head_sha: p.commitSha!, status: "completed", conclusion: "failure", created_at: new Date().toISOString() }];
    await followSitePublications();
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.lock, row.error, row.runUrl]).toEqual([
      SitePublicationStatus.FAILED,
      null,
      DEPLOY_MESSAGES.buildFailed,
      "https://github.com/K0uzia/KouziaWebsite/actions/runs/43",
    ]);
  });

  it("jeton sans Actions en lecture : « Construction en cours », puis LIVE par version.json seul", async () => {
    const p = await dispatched();
    fake.actionsStatus = 403;
    await followSitePublications();
    let row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.error]).toEqual([SitePublicationStatus.DISPATCHED, null]);
    expect(publicationOut(row)).toMatchObject({ watching: true, phase: DEPLOY_MESSAGES.building });
    fake.online = p.commitSha;
    await followSitePublications();
    row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.LIVE);
  });

  it("run remplacé (cancelled) par une publication plus récente : pas un échec ; LIVE quand le commit en ligne la contient", async () => {
    const p = await dispatched();
    fake.runs = [{ html_url: "https://github.com/K0uzia/KouziaWebsite/actions/runs/46", head_sha: p.commitSha!, status: "completed", conclusion: "cancelled", created_at: new Date().toISOString() }];
    await followSitePublications();
    let row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.error, row.lock]).toEqual([SitePublicationStatus.BUILDING, null, null]);
    expect(publicationOut(row)).toMatchObject({ watching: true, phase: DEPLOY_MESSAGES.building });
    const recent = sha("7");
    fake.online = recent;
    await followSitePublications();
    expect((await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(SitePublicationStatus.BUILDING);
    fake.descendants.add(`${p.commitSha}>${recent}`);
    await followSitePublications();
    row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.LIVE);
  });

  it("run d'un autre commit : ignoré (le suivi ne regarde que le commit publié)", async () => {
    const p = await dispatched();
    fake.runs = [{ html_url: "https://github.com/K0uzia/KouziaWebsite/actions/runs/50", head_sha: sha("9"), status: "completed", conclusion: "failure", created_at: new Date().toISOString() }];
    await followSitePublications();
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.error]).toEqual([SitePublicationStatus.DISPATCHED, null]);
  });

  it("construction verte : « Mise en ligne par Hostinger… », verrou libéré aussitôt, puis LIVE si version.json le montre", async () => {
    const p = await dispatched();
    fake.runs = [{ html_url: "https://github.com/K0uzia/KouziaWebsite/actions/runs/44", head_sha: p.commitSha!, status: "completed", conclusion: "success", created_at: new Date().toISOString() }];
    await followSitePublications();
    let row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.lock, row.runUrl, row.error]).toEqual([SitePublicationStatus.DEPLOYED, null, "https://github.com/K0uzia/KouziaWebsite/actions/runs/44", null]);
    expect(publicationOut(row)).toMatchObject({ running: false, watching: true, phase: DEPLOY_MESSAGES.hosting });
    // Le verrou libre permet une nouvelle publication sans attendre les 10 minutes.
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: `Autre réponse ${Math.random()}` } });
    const next = await publishSite();
    expect(next.status).toBe(SitePublicationStatus.DISPATCHED);
    fake.online = p.commitSha;
    fake.runs = [];
    await followSitePublications();
    row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.LIVE);
    expect(publicationOut(row)).toMatchObject({ watching: false, phase: DEPLOY_MESSAGES.live });
  });

  it("construction verte mais pas en ligne après 10 minutes : FAILED, vérifier le déploiement Git de hPanel", async () => {
    const p = await dispatched();
    fake.runs = [{ html_url: "https://github.com/K0uzia/KouziaWebsite/actions/runs/45", head_sha: p.commitSha!, status: "completed", conclusion: "success", created_at: new Date().toISOString() }];
    await followSitePublications();
    await followSitePublications(new Date(Date.now() + PUBLICATION_LIVE_TIMEOUT_MS + 1000));
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.FAILED);
    expect(row.error).toBe(DEPLOY_MESSAGES.notLive);
    expect(row.runUrl).toBe("https://github.com/K0uzia/KouziaWebsite/actions/runs/45");
  });

  it("pas en ligne après 10 minutes : FAILED avec l'alerte hPanel, verrou libéré", async () => {
    const p = await dispatched();
    await followSitePublications(new Date(Date.now() + PUBLICATION_LIVE_TIMEOUT_MS + 1000));
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.FAILED);
    expect(row.error).toBe(DEPLOY_MESSAGES.notLive);
    expect(row.lock).toBeNull();
  });
});

describe("rappel signé de l'Action (POST /api/webhooks/site-deploy)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.SITE_DEPLOY_WEBHOOK_SECRET = SECRET;
    app = await buildApp({ silent: true, serveStatic: false });
  });
  afterAll(async () => {
    delete process.env.SITE_DEPLOY_WEBHOOK_SECRET;
    await app.close();
  });

  const send = (body: Record<string, string>, opts: { secret?: string; at?: number; tamper?: boolean; delivery?: string } = {}) => {
    const payload = JSON.stringify(body);
    const at = String(opts.at ?? Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${at}.${payload}`).digest("hex");
    return app.inject({
      method: "POST",
      url: "/api/webhooks/site-deploy",
      payload: opts.tamper ? payload.replace("deploye", "echec__") : payload,
      headers: {
        "content-type": "application/json",
        "x-kouzia-horodatage": at,
        "x-kouzia-livraison": opts.delivery ?? body.livraison!,
        "x-kouzia-signature": `sha256=${sig}`,
      },
    });
  };
  const event = (s: string, resultat = "deploye", livraison = "1001-1") => ({
    sha: s,
    resultat,
    run: "https://github.com/K0uzia/KouziaWebsite/actions/runs/1001",
    livraison,
  });

  it("signature valide : DEPLOYED, puis LIVE quand version.json montre le commit", async () => {
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Réponse webhook." } });
    const p = await publishSite();
    const res = await send(event(p.commitSha!));
    expect(res.statusCode).toBe(204);
    let row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.runUrl, row.lock]).toEqual([SitePublicationStatus.DEPLOYED, "https://github.com/K0uzia/KouziaWebsite/actions/runs/1001", null]);
    fake.online = p.commitSha;
    await followSitePublications();
    row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.LIVE);
  });

  it("résultat « refuse » : FAILED avec le motif", async () => {
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Réponse refusée." } });
    const p = await publishSite();
    expect((await send(event(p.commitSha!, "refuse", "1002-1"))).statusCode).toBe(204);
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.status, row.error]).toEqual([SitePublicationStatus.FAILED, "L'Action du site a refusé ce commit."]);
  });

  it("résultat « non-configure » (accès Hostinger absents côté GitHub) : FAILED avec le guide, pas « rappel non reçu »", async () => {
    const q = await prisma.siteFaq.findFirstOrThrow();
    await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Réponse sans déploiement configuré." } });
    const p = await publishSite();
    expect((await send(event(p.commitSha!, "non-configure", "1004-1"))).statusCode).toBe(204);
    const row = await prisma.sitePublication.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe(SitePublicationStatus.FAILED);
    expect(row.error).toBe(
      "Déploiement non configuré : le contenu est dans le dépôt, mais GitHub n'a pas les accès Hostinger. Voir le guide docs/deploiement-hostinger.md du site.",
    );
    expect(publicationOut(row)).toMatchObject({ watching: false, phase: null });
  });

  it("signature fausse, corps modifié d'un octet, secret absent : 404 comme une route inconnue", async () => {
    const unknown = await app.inject({ method: "POST", url: "/api/webhooks/inconnu", payload: {} });
    for (const res of [await send(event(sha("b")), { secret: "autre" }), await send(event(sha("b")), { tamper: true })]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
    delete process.env.SITE_DEPLOY_WEBHOOK_SECRET;
    expect((await send(event(sha("b"), "deploye", "1003-1"))).statusCode).toBe(404);
    process.env.SITE_DEPLOY_WEBHOOK_SECRET = SECRET;
    expect(await prisma.siteDeployEvent.count()).toBe(0);
  });

  it("horodatage hors fenêtre de 5 minutes : refusé ; livraison rejouée : sans effet", async () => {
    expect((await send(event(sha("b"), "deploye", "1004-1"), { at: Math.floor(Date.now() / 1000) - 301 })).statusCode).toBe(400);
    expect((await send(event(sha("b"), "echec", "1005-1"))).statusCode).toBe(204);
    expect((await send(event(sha("b"), "echec", "1005-1"))).statusCode).toBe(204);
    expect(await prisma.siteDeployEvent.count({ where: { deliveryId: "1005-1" } })).toBe(1);
  });

  it("livraison de l'en-tête différente de celle du corps : refusée", async () => {
    expect((await send(event(sha("b"), "deploye", "1006-1"), { delivery: "9999-1" })).statusCode).toBe(400);
  });

  it("publication et historique par les routes admin exigent la session", async () => {
    for (const [method, url] of [
      ["GET", "/api/site/publications"],
      ["GET", "/api/site/publish/preview"],
      ["POST", "/api/site/publish"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(401);
    }
  });
});
