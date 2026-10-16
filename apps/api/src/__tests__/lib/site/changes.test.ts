import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { SitePublicationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { FILES_RETENTION, itemHash, pendingChanges, publicationState, recordPublished } from "@/lib/site/changes.js";
import { writeSiteText } from "@/lib/site/texts.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`).replace(/\r\n/g, "\n")])) as Record<SiteFileName, string>;

/** Publication arrivée dans le dépôt (NOOP), comme après publishSite : empreintes et fichiers enregistrés. */
async function publier() {
  const readAt = new Date();
  const snapshot = await buildSiteSnapshot();
  const row = await prisma.sitePublication.create({ data: { status: SitePublicationStatus.NOOP, digest: snapshot.digest, summaryJson: "[]" } });
  await recordPublished(readAt, snapshot, row.id);
}
const changes = async () => (await pendingChanges(await buildSiteSnapshot())).changes;

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await importSiteFiles(raw);
});

describe("état de publication calculé sans GitHub", () => {
  it("contenu repris du site : publié, rien à publier, même avant toute empreinte", async () => {
    const p = await prisma.siteProject.findFirstOrThrow();
    expect(publicationState(p, itemHash("projects", p))).toBe("published");
    expect(await changes()).toEqual([]);
  });

  it("après publication : modifié, nouveau, retrait et texte détectés ; une nouvelle publication les efface", async () => {
    await publier();
    expect(await changes()).toEqual([]);

    const [q1] = await prisma.siteFaq.findMany({ orderBy: { position: "asc" } });
    await prisma.siteFaq.update({ where: { id: q1!.id }, data: { answer: "Réponse revue." } });
    const nouvelle = await prisma.siteFaq.create({ data: { page: "HOME", position: 99, status: "PUBLISHED", question: "Nouvelle question ?", answer: "Réponse." } });
    const projet = await prisma.siteProject.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteProject.update({ where: { id: projet.id }, data: { status: "WITHDRAWN" } });
    const accroche = (await prisma.siteText.findUniqueOrThrow({ where: { key: "accroche" } })).valueJson;
    await writeSiteText("accroche", { ...JSON.parse(accroche), titre: "Titre revu de l'accueil" });

    const c = await changes();
    const parId = Object.fromEntries(c.map((x) => [x.id, x.state]));
    expect(parId[q1!.id]).toBe("modified");
    expect(parId[nouvelle.id]).toBe("new");
    expect(parId[projet.id]).toBe("removal");
    expect(parId.accroche).toBe("modified");
    expect(c.find((x) => x.id === projet.id)?.to).toBe(`/site/realisations/${projet.id}`);

    await publier();
    expect(await changes()).toEqual([]);
    const apres = await prisma.siteProject.findUniqueOrThrow({ where: { id: projet.id } });
    expect(apres.publishedHash).toBeNull();
    expect(publicationState(apres, itemHash("projects", apres))).toBe("withdrawn");
  });

  it("changement sans effet sur le site (notes, accord) : pas « Modifié »", async () => {
    const ref = await prisma.siteReference.create({
      data: { slug: "structure-test", name: "Structure de test", type: "CLIENT", status: "PUBLISHED", url: "https://exemple.fr", onHome: true },
    });
    await publier();
    await prisma.siteReference.update({ where: { id: ref.id }, data: { authorizationChannel: "courriel du 2 octobre" } });
    expect(await changes()).toEqual([]);
  });

  it("ordre seul changé : une ligne « Ordre des questions »", async () => {
    await publier();
    const qs = await prisma.siteFaq.findMany({ orderBy: { position: "asc" } });
    expect(qs.length).toBeGreaterThan(1);
    await prisma.siteFaq.update({ where: { id: qs[0]!.id }, data: { position: qs.length + 5 } });
    expect((await changes()).map((x) => `${x.state}:${x.label}`)).toEqual(["order:Ordre des questions"]);
  });

  it(`rétention : seules les ${FILES_RETENTION} dernières publications gardent leurs fichiers`, async () => {
    const debut = Date.now() - 1000 * 60 * 60;
    for (let i = 0; i < FILES_RETENTION + 2; i++) {
      await prisma.sitePublication.create({
        data: { status: SitePublicationStatus.NOOP, digest: `d${i}`, summaryJson: "[]", filesJson: "{}", startedAt: new Date(debut + i * 1000) },
      });
    }
    await publier();
    expect(await prisma.sitePublication.count({ where: { filesJson: { not: null } } })).toBe(FILES_RETENTION);
    const plusAncienne = await prisma.sitePublication.findFirstOrThrow({ orderBy: { startedAt: "asc" } });
    expect(plusAncienne.filesJson).toBeNull();
  });
});

// Hachage argon2 du compte et démarrage de l'application : environ 8 s quand la machine est chargée.
describe("routes : changements à publier et statut dans les listes", { timeout: 30_000 }, () => {
  const ADMIN = "admin-site-changes@kouzia.test";
  const PASSWORD = "mot-de-passe-de-test";

  it("GET /api/site/changes et publication de chaque élément de liste", async () => {
    const { hashPassword, SESSION_COOKIE } = await import("@/lib/auth.js");
    const { buildApp } = await import("@/app.js");
    const app = await buildApp({ silent: true, serveStatic: false });
    try {
      await prisma.user.deleteMany({ where: { email: ADMIN } });
      await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
      const cookie = `${SESSION_COOKIE}=${login.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
      expect((await app.inject({ method: "GET", url: "/api/site/changes" })).statusCode).toBe(401);

      await publier();
      const q = await prisma.siteFaq.findFirstOrThrow({ orderBy: { position: "asc" } });
      await prisma.siteFaq.update({ where: { id: q.id }, data: { answer: "Réponse revue." } });

      const res = await app.inject({ method: "GET", url: "/api/site/changes", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changes).toEqual([{ collection: "faq", id: q.id, label: q.question, state: "modified", to: "/site/faq" }]);
      expect(body.undetailed).toBe(false);
      expect(body.unpublished).toBe(true);

      const liste = (await app.inject({ method: "GET", url: "/api/site/faq", headers: { cookie } })).json() as Array<{ id: string; publication: string }>;
      expect(liste.find((x) => x.id === q.id)?.publication).toBe("modified");
      expect(liste.filter((x) => x.id !== q.id).every((x) => x.publication === "published")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
