import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { SiteItemStatus, SitePublicationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { pendingChanges, recordPublished } from "@/lib/site/changes.js";
import { publicationDetail, restoreVersion } from "@/lib/site/history.js";
import { readSiteText, writeSiteText } from "@/lib/site/texts.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`).replace(/\r\n/g, "\n")])) as Record<SiteFileName, string>;

let tick = 0;
/** Publication arrivée dans le dépôt, comme après publishSite : fichiers gardés, empreintes enregistrées. */
async function publier(): Promise<string> {
  const readAt = new Date();
  const snapshot = await buildSiteSnapshot();
  const row = await prisma.sitePublication.create({
    data: { status: SitePublicationStatus.NOOP, digest: snapshot.digest, summaryJson: "[]", startedAt: new Date(Date.now() + ++tick * 1000) },
  });
  await recordPublished(readAt, snapshot, row.id);
  return row.id;
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await importSiteFiles(raw);
});

describe("historique des publications", () => {
  it("changements d'une publication : modifié champ par champ, ajouté, retiré, ordre ; première publication suivie : tout ajouté", async () => {
    const p1 = await publier();
    const projet = await prisma.siteProject.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteProject.update({ where: { id: projet.id }, data: { text: "Texte revu pour l'historique." } });
    const [q1, q2] = await prisma.siteFaq.findMany({ where: { page: "HOME" }, orderBy: { position: "asc" } });
    await prisma.siteFaq.update({ where: { id: q1!.id }, data: { position: q2!.position + 1 } });
    await prisma.siteFaq.create({ data: { page: "HOME", position: 99, status: "PUBLISHED", question: "Question ajoutée ?", answer: "Oui." } });
    const retiree = await prisma.siteProject.findFirstOrThrow({ where: { id: { not: projet.id } }, orderBy: { position: "desc" } });
    await prisma.siteProject.update({ where: { id: retiree.id }, data: { status: SiteItemStatus.WITHDRAWN } });
    const accroche = (await readSiteText("accroche"))!;
    await writeSiteText("accroche", { ...accroche, titre: "Titre revu" });
    const p2 = await publier();

    const d2 = await publicationDetail(p2);
    expect(d2).toMatchObject({ available: true, first: false });
    const by = (file: string, kind: string) => d2.entries.filter((e) => e.file === file && e.kind === kind);
    const modifie = by("realisations", "modified")[0]!;
    expect(modifie).toMatchObject({
      key: projet.slug,
      restore: [
        { side: "before", current: "different" },
        { side: "after", current: "same" },
      ],
    });
    expect(modifie.fields).toEqual([{ name: "Texte", before: projet.text, after: "Texte revu pour l'historique." }]);
    expect(by("realisations", "removed")[0]).toMatchObject({ key: retiree.slug, restore: [{ side: "before", current: "same" }] });
    expect(by("faq", "added").map((e) => e.label)).toEqual(["Question ajoutée ?"]);
    expect(by("faq", "order")).toHaveLength(1);
    expect(by("textes", "modified")[0]!.fields).toEqual([{ name: "Titre", before: accroche.titre, after: "Titre revu" }]);

    const d1 = await publicationDetail(p1);
    expect(d1.first).toBe(true);
    expect(d1.entries.every((e) => e.kind === "added")).toBe(true);
    // Témoignages : affichés, jamais restaurables.
    expect(d1.entries.filter((e) => e.file === "avis" && e.key !== "avisMethode").every((e) => e.restore.length === 0)).toBe(true);

    // Annuler une modification : la version d'avant, depuis la publication qui l'a changée.
    await restoreVersion(p2, "realisations", projet.slug, "before");
    expect((await prisma.siteProject.findUniqueOrThrow({ where: { id: projet.id } })).text).toBe(projet.text);
    expect((await publicationDetail(p2)).entries.find((e) => e.key === projet.slug && e.kind === "modified")!.restore).toEqual([
      { side: "before", current: "same" },
      { side: "after", current: "different" },
    ]);

    // Publication sans fichiers gardés (avant le suivi, ou au-delà de la rétention) : pas de détail.
    const ancienne = await prisma.sitePublication.create({
      data: { status: SitePublicationStatus.LIVE, digest: "x", summaryJson: "[]", commitSha: "abc", startedAt: new Date(0) },
    });
    expect(await publicationDetail(ancienne.id)).toEqual({ available: false, first: false, entries: [] });
  });

  it("restaurer : la fiche reprend la version publiée sans changer de statut ; une fiche supprimée revient en brouillon ; rien ne part en ligne", async () => {
    const p1 = await publier();
    const projet = await prisma.siteProject.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteProject.update({ where: { id: projet.id }, data: { text: "Texte revu", name: "Nom revu" } });
    await publier();

    const r = await restoreVersion(p1, "realisations", projet.slug, "after");
    expect(r).toMatchObject({ created: false, to: `/site/realisations/${projet.id}`, missingMedia: [] });
    const apres = await prisma.siteProject.findUniqueOrThrow({ where: { id: projet.id } });
    expect(apres).toMatchObject({ text: projet.text, name: projet.name, status: projet.status, position: projet.position });
    // Rien n'est publié : la restauration est un changement à publier comme un autre.
    const { changes } = await pendingChanges(await buildSiteSnapshot());
    expect(changes).toContainEqual(expect.objectContaining({ id: projet.id, state: "modified" }));

    await prisma.siteProject.delete({ where: { id: projet.id } });
    const recree = await restoreVersion(p1, "realisations", projet.slug, "after");
    expect(recree.created).toBe(true);
    expect(await prisma.siteProject.findUniqueOrThrow({ where: { slug: projet.slug } })).toMatchObject({ status: "DRAFT", text: projet.text });

    const avis = (await publicationDetail(p1)).entries.find((e) => e.file === "avis" && e.key !== "avisMethode");
    if (avis) await expect(restoreVersion(p1, "avis", avis.key, "after")).rejects.toMatchObject({ status: 422 });
    await expect(restoreVersion(p1, "realisations", "inconnue", "after")).rejects.toMatchObject({ status: 404 });
  });

  it("restaurer un texte et une question supprimée", async () => {
    const p1 = await publier();
    const accroche = (await readSiteText("accroche"))!;
    await writeSiteText("accroche", { ...accroche, titre: "Autre titre" });
    const q = await prisma.siteFaq.findFirstOrThrow({ orderBy: { position: "asc" } });
    await prisma.siteFaq.delete({ where: { id: q.id } });
    await publier();

    expect(await restoreVersion(p1, "textes", "accroche", "after")).toMatchObject({ to: "/site/tous-les-textes?page=accueil" });
    expect((await readSiteText("accroche"))!.titre).toBe(accroche.titre);
    const key = (await publicationDetail(p1)).entries.find((e) => e.file === "faq" && e.label === q.question)!.key;
    expect(await restoreVersion(p1, "faq", key, "after")).toMatchObject({ created: true });
    expect(await prisma.siteFaq.findFirstOrThrow({ where: { question: q.question } })).toMatchObject({ answer: q.answer, status: "DRAFT" });
  });
});

describe("historique des documents facultatifs (lot 6)", () => {
  it("textes des pages : changement champ par champ, restauration du document d'avant", async () => {
    await writeSiteText("pages", { pages: { accueil: { services: { titre: "Ce que je fais" } } } });
    const p1 = await publier();
    await writeSiteText("pages", { pages: { accueil: { services: { titre: "Ce que je fais à {ville}" } } } });
    const p2 = await publier();
    const entree = (await publicationDetail(p2)).entries.find((e) => e.file === "pages")!;
    expect(entree).toMatchObject({ kind: "modified", label: "Textes des pages" });
    expect(entree.fields).toEqual([{ name: "Pages › Accueil › Services › Titre", before: "Ce que je fais", after: "Ce que je fais à {ville}" }]);
    expect(await restoreVersion(p2, "pages", "pages", "before")).toMatchObject({ to: "/site/tous-les-textes?page=accueil" });
    expect(await readSiteText("pages")).toEqual({ pages: { accueil: { services: { titre: "Ce que je fais" } } } });
    void p1;
  });
});

describe("routes de l'historique", () => {
  const ADMIN = "admin-site-historique@kouzia.test";
  const PASSWORD = "mot-de-passe-de-test";

  it("détail et restauration : session admin, entrée validée", async () => {
    const { hashPassword, SESSION_COOKIE } = await import("@/lib/auth.js");
    const { buildApp } = await import("@/app.js");
    const app = await buildApp({ silent: true, serveStatic: false });
    try {
      await prisma.user.deleteMany({ where: { email: ADMIN } });
      await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
      const cookie = `${SESSION_COOKIE}=${login.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
      const p1 = await publier();
      expect((await app.inject({ method: "GET", url: `/api/site/publications/${p1}/detail` })).statusCode).toBe(401);
      const detail = await app.inject({ method: "GET", url: `/api/site/publications/${p1}/detail`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ available: true, first: true });
      expect((await app.inject({ method: "GET", url: "/api/site/publications/inconnue/detail", headers: { cookie } })).statusCode).toBe(404);
      const bad = await app.inject({ method: "POST", url: `/api/site/publications/${p1}/restore`, headers: { cookie }, payload: { file: "autre", key: "x", side: "after" } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({ method: "POST", url: `/api/site/publications/${p1}/restore`, headers: { cookie }, payload: { file: "textes", key: "offres", side: "after" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ to: "/site/tous-les-textes?page=sitesWeb", label: "Offres et tarifs" });
    } finally {
      await app.close();
    }
    // Import de toute l'application : plusieurs secondes quand le cache de transformation est froid.
  }, 60_000);
});
