// Référencement par page (seo.json) et menus (menus.json) : contrat, valeurs finales, publication conditionnelle.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { menusValue, pagesValue, seoValue, SITE_FILES, validateOptionalSiteFiles, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { recordPublished } from "@/lib/site/changes.js";
import { writeSiteText } from "@/lib/site/texts.js";
import { defaultsFromContract, fillVariables, finalMenus, finalSeo, finalSeoIssues, type SiteDefaults } from "@/lib/site/seo-menus.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Fichiers réels du site (main 600dec6) et contrat du lot 6 (KouziaWebsite integration b2b331c).
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`)])) as Record<SiteFileName, string>;
const oldContract = JSON.parse(fixture("contenu.schema.json")) as unknown;
const contract = JSON.parse(fixture("contenu.schema.lot6.json")) as unknown;
const defaults = defaultsFromContract(contract) as SiteDefaults;
const vars = { ville: "Huelgoat", delaiReponse: "sous 48 h" };

/** Description valide de n caractères (140 à 155), unique par graine. */
const description = (seed: string, n = 150) => `${seed} : création de sites et de logiciels sur mesure dans le Finistère. `.padEnd(n, "x");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

describe("contrat seo.json et menus.json", () => {
  it("valeurs actuelles lues dans le contrat du site ; absentes d'un contrat antérieur au lot 6", () => {
    expect(defaults.seo.sitesWeb!.titre).toBe("Création de site internet dans le Finistère | Kouzia");
    expect(defaults.menus.entete.map((e) => e.cible)).toEqual(["sitesWeb", "logiciels", "realisations", "aPropos"]);
    expect(defaults.cibles.espaceClient).toEqual({ libelle: "Espace client", chemin: "/suivi/" });
    expect(defaultsFromContract(oldContract)).toBeNull();
  });

  it.each([
    ["titre sous accueil (charte)", { pages: { accueil: { titre: "Autre titre" } } }],
    ["titre de 61 caractères", { pages: { faq: { titre: "x".repeat(61) } } }],
    ["description de 139 caractères", { pages: { faq: { description: description("a", 139) } } }],
    ["description de 156 caractères", { pages: { faq: { description: description("a", 156) } } }],
    ["image en WebP", { pages: { faq: { image: "/media/abcdef123456.webp" } } }],
    ["variable inconnue", { pages: { faq: { titre: "Kouzia à {commune}" } } }],
    ["tiret long", { pages: { faq: { titre: `Kouzia ${String.fromCharCode(0x2014)} Huelgoat` } } }],
    ["page inconnue", { pages: { contact: {} } }],
  ])("seo refusé : %s (ERP et contrat du site)", (_label, value) => {
    expect(seoValue.safeParse(value).success).toBe(false);
    expect(validateOptionalSiteFiles({ seo: { schemaVersion: 1, ...value } }, contract).length).toBeGreaterThan(0);
  });

  it.each([
    ["espace client dans l'en-tête", { entete: [{ cible: "espaceClient" }] }],
    ["cible en double", { pied: [{ cible: "faq" }, { cible: "faq" }] }],
    ["7 liens d'en-tête", { entete: ["accueil", "sitesWeb", "logiciels", "faq", "aPropos", "contact", "methode"].map((cible) => ({ cible })) }],
    ["liste vide", { pied: [] }],
    ["libellé de 31 caractères", { entete: [{ cible: "faq", libelle: "x".repeat(31) }] }],
    ["cible inconnue", { pied: [{ cible: "mentionsLegales" }] }],
  ])("menus refusés : %s", (_label, value) => {
    expect(menusValue.safeParse(value).success).toBe(false);
    expect(validateOptionalSiteFiles({ menus: { schemaVersion: 1, ...value } }, contract).length).toBeGreaterThan(0);
  });

  it("pages.json : les textes actuels du site passent ; astérisques d'accent seulement dans les deux titres prévus, une paire au plus", () => {
    const current = (contract as { defauts: { pages: unknown } }).defauts.pages;
    expect(pagesValue.safeParse({ pages: current }).success).toBe(true);
    expect(validateOptionalSiteFiles({ pages: { schemaVersion: 1, pages: current } }, contract)).toEqual([]);
    for (const bad of [
      { pages: { faq: { intro: "Les *questions* fréquentes" } } },
      { pages: { accueil: { hero: { titre: "Des *sites* et des *logiciels*" } } } },
      { pages: { accueil: { zone: { texte: "Basé à {commune}" } } } },
      { pages: { mentions: {} } },
    ]) {
      expect(pagesValue.safeParse(bad).success).toBe(false);
      expect(validateOptionalSiteFiles({ pages: { schemaVersion: 1, ...bad } }, contract).length).toBeGreaterThan(0);
    }
  });

  it("valeurs valides acceptées par l'ERP et par le contrat du site", () => {
    const seo = { pages: { accueil: { description: description("Accueil"), imageAlt: "Kouzia à {ville}" }, faq: { titre: "FAQ | Kouzia", image: "/media/abcdef123456.jpg" } } };
    const menus = { entete: [{ cible: "sitesWeb" }, { cible: "contact", libelle: "Me joindre" }], pied: [{ cible: "espaceClient" }] };
    expect(seoValue.parse(seo)).toEqual(seo);
    expect(menusValue.parse(menus)).toEqual(menus);
    expect(validateOptionalSiteFiles({ seo: { schemaVersion: 1, ...seo }, menus: { schemaVersion: 1, ...menus } }, contract)).toEqual([]);
  });
});

describe("valeurs finales (comme valider.ts au build du site)", () => {
  it("valeur de l'ERP sinon valeur actuelle, variables remplacées ; titre de l'accueil fixe", () => {
    const final = finalSeo({ pages: { faq: { titre: "FAQ à {ville}" } } }, defaults, vars);
    expect(final.faq.title).toBe("FAQ à Huelgoat");
    expect(final.accueil.title).toBe(defaults.seo.accueil!.titre);
    expect(final.accueil.description).toContain("Devis gratuit sous 48 h.");
    expect(final.sitesWeb.image).toBe("/og-kouzia.jpg");
    expect(fillVariables("{ville}, {delaiReponse}", vars)).toBe("Huelgoat, sous 48 h");
    expect(finalSeoIssues(null, defaults, vars)).toEqual([]);
  });

  it("description en double avec une valeur actuelle : refusée ; longueur comptée après remplacement", () => {
    const twin = finalSeoIssues({ pages: { faq: { description: defaults.seo.logiciels!.description } } }, defaults, vars);
    expect(twin).toEqual([expect.objectContaining({ path: "faq.description", message: expect.stringMatching(/« Logiciels »/) })]);
    // 153 caractères bruts, 156 une fois {delaiReponse} (14 caractères) remplacé par « sous 48 h ouvrées » (17).
    const long = finalSeoIssues({ pages: { faq: { description: description("{delaiReponse}", 153) } } }, defaults, { ...vars, delaiReponse: "sous 48 h ouvrées" });
    expect(long).toContainEqual(expect.objectContaining({ path: "faq.description", message: expect.stringMatching(/^156 caractères/) }));
    // La description actuelle de l'accueil contient aussi {delaiReponse} : un délai plus long la fait dépasser.
    expect(long).toContainEqual(expect.objectContaining({ path: "accueil.description" }));
  });

  it("menus : ceux de l'ERP avec libellé et chemin, sinon ceux du site", () => {
    const m = finalMenus({ entete: [{ cible: "contact", libelle: "Me joindre" }, { cible: "faq" }] }, defaults);
    expect(m.entete).toEqual([
      { cible: "contact", libelle: "Me joindre", chemin: "/#contact" },
      { cible: "faq", libelle: "Questions fréquentes", chemin: "/faq/" },
    ]);
    expect(m.pied.map((e) => e.cible)).toEqual(defaults.menus.pied.map((e) => e.cible));
  });
});

describe("publication des fichiers facultatifs", () => {
  async function withSiteContent() {
    await importSiteFiles(raw);
    await writeSiteText("menus", { entete: [{ cible: "sitesWeb" }, { cible: "contact" }] });
  }

  it("contrat du site antérieur au lot 6 : rien ne part, et rien n'est marqué publié", async () => {
    await withSiteContent();
    const before = await buildSiteSnapshot(oldContract);
    expect(before.files.menus).toBeUndefined();
    expect(before.issues).toEqual([]);
    const publication = await prisma.sitePublication.create({ data: { digest: before.digest, summaryJson: "[]" } });
    await recordPublished(new Date(Date.now() + 1000), before, publication.id);
    expect((await prisma.siteText.findUniqueOrThrow({ where: { key: "menus" } })).publishedHash).toBeNull();
  });

  it("contrat du lot 6 : menus.json et seo.json écrits, image de partage citée en .jpg, contrôles finaux appliqués", async () => {
    await withSiteContent();
    const sha = "abcdef123456";
    await prisma.siteMedia.create({ data: { sha12: sha, kind: "PARTAGE", width: 1200, height: 630, bytes: 90_000 } });
    await writeSiteText("seo", { pages: { faq: { titre: "FAQ | Kouzia", image: `/media/${sha}.jpg` } } });
    const snap = await buildSiteSnapshot(contract);
    expect(snap.issues).toEqual([]);
    expect(JSON.parse(snap.files.menus!)).toEqual({ schemaVersion: 1, entete: [{ cible: "sitesWeb" }, { cible: "contact" }] });
    expect(JSON.parse(snap.files.seo!).pages.faq.titre).toBe("FAQ | Kouzia");
    expect(snap.media).toEqual([sha]);
    expect(snap.mediaExt[sha]).toBe("jpg");
    expect(snap.mediaNames[sha]).toBe("image de partage de la page « Questions fréquentes »");

    await writeSiteText("seo", { pages: { faq: { description: defaults.seo.aPropos!.description } } });
    expect((await buildSiteSnapshot(contract)).issues).toEqual([
      expect.objectContaining({ file: "seo", path: "aPropos.description", message: expect.stringMatching(/« Questions fréquentes »/) }),
    ]);
  });

  it("sans document : aucun fichier facultatif, empreinte inchangée", async () => {
    await importSiteFiles(raw);
    const a = await buildSiteSnapshot(oldContract);
    const b = await buildSiteSnapshot(contract);
    expect([b.files.seo, b.files.menus]).toEqual([undefined, undefined]);
    expect(b.digest).toBe(a.digest);
  });
});
