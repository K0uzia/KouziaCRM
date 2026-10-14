import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteAuthorizationScope, SiteItemStatus, SiteReferenceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, serializeSiteFile, validateSiteFiles, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles, SiteImportError } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Fichiers réels du site (KouziaWebsite, src/content/site, main 08bfe72) : le contrat et son export.
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`)])) as Record<SiteFileName, string>;
const contract = JSON.parse(fixture("contenu.schema.json")) as unknown;
const parsed = () => Object.fromEntries(SITE_FILES.map((n) => [n, JSON.parse(raw[n])])) as Record<SiteFileName, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

describe("contrat du contenu publié", () => {
  it("les fichiers du site sont conformes (règles de l'ERP et contenu.schema.json) et se resérialisent à l'identique", () => {
    expect(validateSiteFiles(parsed(), contract)).toEqual([]);
    for (const n of SITE_FILES) expect(serializeSiteFile(JSON.parse(raw[n]))).toBe(raw[n].replace(/\r\n/g, "\n"));
  });

  it.each([
    ["lien http", (f: ReturnType<typeof parsed>) => (f.realisations.realisations[0].url = "http://exemple.fr/")],
    ["lien vers du code source", (f: ReturnType<typeof parsed>) => (f.realisations.realisations[0].url = "https://github.com/K0uzia/Tracebay")],
    ["tiret cadratin", (f: ReturnType<typeof parsed>) => (f.textes.accroche.titre = "Sites \u2014 logiciels")],
    ["tiret demi-cadratin", (f: ReturnType<typeof parsed>) => (f.faq.questions[0].r = "1 \u2013 2")],
    ["identifiants en double", (f: ReturnType<typeof parsed>) => f.realisations.realisations.push({ ...f.realisations.realisations[0] })],
    [
      "produit manquant pour « Ils l'utilisent »",
      (f: ReturnType<typeof parsed>) => f.references.references.push({ id: "asso", type: "UTILISATEUR", nom: "Asso" }),
    ],
    ["champ inconnu", (f: ReturnType<typeof parsed>) => (f.infos.infos.horaires = "9 h - 18 h")],
  ])("refuse : %s (sans le contrat du site, par les seules règles de l'ERP)", (_label, mutate) => {
    const files = parsed();
    mutate(files);
    expect(validateSiteFiles(files).length).toBeGreaterThan(0);
  });

  it("refuse un contrat du site d'un autre format", () => {
    expect(() => validateSiteFiles(parsed(), { schemaVersion: 2, fichiers: {} })).toThrow(/format 2/);
  });
});

describe("import puis instantané", () => {
  it("aller-retour : les fichiers régénérés sont identiques octet pour octet (publication à vide sans commit)", async () => {
    await importSiteFiles(raw);
    const snap = await buildSiteSnapshot(contract);
    expect(snap.issues).toEqual([]);
    for (const n of SITE_FILES) expect(snap.files[n]).toBe(raw[n].replace(/\r\n/g, "\n"));
    expect(snap.media).toEqual([]);
    expect((await buildSiteSnapshot()).digest).toBe(snap.digest);
  });

  it("capture de téléphone facultative (imageMobile) : reprise à l'identique ; image inconnue bloquante", async () => {
    const files = parsed();
    files.realisations.realisations[0].imageMobile = "/media/0123456789ab.webp";
    const withMobile = { ...raw, realisations: serializeSiteFile(files.realisations) };
    await importSiteFiles(withMobile);
    expect((await prisma.siteProject.findFirstOrThrow({ where: { slug: files.realisations.realisations[0].id } })).imageMobilePath).toBe(
      "/media/0123456789ab.webp",
    );
    const snap = await buildSiteSnapshot(contract);
    expect(snap.files.realisations).toBe(withMobile.realisations);
    expect(snap.media).toEqual(["0123456789ab"]);
    expect(snap.issues.map((i) => i.message)).toContain("Image introuvable dans l'ERP");
  });

  it("captures de téléphone réelles (main 08bfe72) : importées telles quelles, tracebay sans clé, aucun écart à republier", async () => {
    await importSiteFiles(raw);
    const rows = await prisma.siteProject.findMany({ orderBy: { position: "asc" } });
    expect(Object.fromEntries(rows.map((r) => [r.slug, r.imageMobilePath]))).toEqual({
      tracebay: null,
      "morlaix-communaute": "/projets/morlaix-mobile.webp",
      capsuleos: "/projets/capsuleos-mobile.webp",
      "la-capsule": "/projets/lacapsule-mobile.webp",
      "ulamir-cpie": "/projets/ulamir-mobile.webp",
      "ssa-pays-de-morlaix": "/projets/ssa-mobile.webp",
    });
    const snap = await buildSiteSnapshot(contract);
    expect(snap.issues).toEqual([]);
    expect(snap.files.realisations).toBe(raw.realisations.replace(/\r\n/g, "\n"));
  });

  it("une seule fois, sur un espace Site vide", async () => {
    await importSiteFiles(raw);
    await expect(importSiteFiles(raw)).rejects.toMatchObject({ code: "NOT_EMPTY" });
  });

  it("refuse un fichier non conforme, sans rien écrire", async () => {
    const bad = { ...raw, realisations: raw.realisations.replace("https://k0uzia.github.io", "http://k0uzia.github.io") };
    await expect(importSiteFiles(bad)).rejects.toBeInstanceOf(SiteImportError);
    expect(await prisma.siteProject.count()).toBe(0);
    expect(await prisma.siteText.count()).toBe(0);
  });

  it("brouillons et retraits hors publication ; accords manquants et produit inconnu bloquent", async () => {
    await importSiteFiles(raw);
    const before = await buildSiteSnapshot();
    await prisma.siteFaq.updateMany({ data: { status: SiteItemStatus.WITHDRAWN } });
    expect(JSON.parse((await buildSiteSnapshot()).files.faq).questions).toEqual([]);
    expect((await buildSiteSnapshot()).digest).not.toBe(before.digest);

    await prisma.siteReview.create({
      data: { status: SiteItemStatus.PUBLISHED, author: "Lou", reviewedOn: "2026-10-01", text: "Très bien." },
    });
    await prisma.siteReference.create({
      data: {
        status: SiteItemStatus.PUBLISHED,
        slug: "asso",
        type: SiteReferenceType.USER,
        name: "Asso",
        productSlug: "inconnu",
        logoPath: "/media/0123456789ab.webp",
        authorizationAt: new Date(),
        authorizationScope: SiteAuthorizationScope.NAME,
      },
    });
    const messages = (await buildSiteSnapshot()).issues.map((i) => i.message);
    expect(messages).toContain("Accord de l'auteur non renseigné");
    expect(messages).toContain("Logo publié sans autorisation pour le logo");
    expect(messages).toContain("Produit « inconnu » absent des réalisations publiées");
    expect(messages).toContain("Image introuvable dans l'ERP");
  });
});
