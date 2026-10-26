// Référencement par page (seo.json) et menus (menus.json) : contrat, valeurs finales, publication conditionnelle.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { menusValue, pagesValue, seoValue, serializeSiteFile, SITE_FILES, validateOptionalSiteFiles, type SiteFileName } from "@/lib/site/contract.js";
import { adoptMissingMedia } from "@/lib/site/library.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { recordPublished } from "@/lib/site/changes.js";
import { writeSiteText } from "@/lib/site/texts.js";
import { defaultsFromContract, fillVariables, finalMenus, finalSeo, finalSeoIssues, textVariables, type SiteDefaults } from "@/lib/site/seo-menus.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Fichiers réels du site (main 600dec6), le contrat de cette version et le contrat en ligne (KouziaWebsite main 7880574).
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`)])) as Record<SiteFileName, string>;
const oldContract = JSON.parse(fixture("contenu.schema.600dec6.json")) as unknown;
const contract = JSON.parse(fixture("contenu.schema.json")) as unknown;
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
    const final = finalSeo({ pages: { faq: { titre: "FAQ à {ville}", description: description("Réponse {delaiReponse}") } } }, defaults, vars);
    expect(final.faq.title).toBe("FAQ à Huelgoat");
    expect(final.faq.description).toContain("Réponse sous 48 h :");
    expect(final.accueil.title).toBe(defaults.seo.accueil!.titre);
    expect(final.accueil.description).toBe(defaults.seo.accueil!.description);
    expect(final.sitesWeb.image).toBe("/og-kouzia.jpg");
    expect(fillVariables("{ville}, {delaiReponse}", vars)).toBe("Huelgoat, sous 48 h");
    expect(finalSeoIssues(null, defaults, vars)).toEqual([]);
  });

  it("description en double avec une valeur actuelle : refusée ; longueur comptée après remplacement", () => {
    const twin = finalSeoIssues({ pages: { faq: { description: defaults.seo.logiciels!.description } } }, defaults, vars);
    expect(twin).toEqual([expect.objectContaining({ path: "faq.description", message: expect.stringMatching(/« Logiciels »/) })]);
    // 153 caractères bruts, 156 une fois {delaiReponse} (14 caractères) remplacé par « sous 48 h ouvrées » (17).
    const long = finalSeoIssues({ pages: { faq: { description: description("{delaiReponse}", 153) } } }, defaults, { ...vars, delaiReponse: "sous 48 h ouvrées" });
    expect(long).toEqual([expect.objectContaining({ path: "faq.description", message: expect.stringMatching(/^156 caractères/) })]);
  });

  it("{ville} : valeur exportée par le site (defauts.variables), sinon ville des réglages ; {delaiReponse} : coordonnées de l'ERP", async () => {
    await importSiteFiles(raw);
    expect(defaults.variables).toEqual({ ville: "Huelgoat" });
    // Contrat du lot 6 antérieur à l'export de la ville (b2b331c) : pas de variables.
    const withoutCity = JSON.parse(JSON.stringify(contract)) as { defauts: Record<string, unknown> };
    delete withoutCity.defauts.variables;
    expect(defaultsFromContract(withoutCity)!.variables).toBeUndefined();
    const delai = JSON.parse(raw.infos).infos.delaiReponse as string;
    expect(await textVariables("Huelgoat")).toEqual({ ville: "Huelgoat", delaiReponse: delai });
    // Contrat antérieur (sans variables) : ville des réglages de l'entreprise (Quimper dans la fabrique de test).
    expect(await textVariables(undefined)).toEqual({ ville: "Quimper", delaiReponse: delai });
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

  it("sans seo.json : description actuelle avec {delaiReponse} trop longue avec un délai plus long, publication bloquée", async () => {
    await importSiteFiles(raw);
    const infos = await prisma.siteText.findUniqueOrThrow({ where: { key: "infos" } });
    await writeSiteText("infos", { ...JSON.parse(infos.valueJson), delaiReponse: "sous 24 à 48 heures ouvrées" });
    // Description actuelle de l'accueil sans variable (site en ligne) : rien à bloquer.
    expect((await buildSiteSnapshot(contract)).issues).toEqual([]);
    // Site dont la description actuelle contient {delaiReponse} (texte de b2b331c) : un délai plus long la fait dépasser.
    const withVariable = JSON.parse(JSON.stringify(contract)) as { defauts: { seo: { accueil: { description: string } } } };
    withVariable.defauts.seo.accueil.description =
      "Développeur web à Huelgoat, près de Morlaix (Finistère) : création de sites internet, applications et logiciels sur mesure. Devis gratuit {delaiReponse}.";
    const snap = await buildSiteSnapshot(withVariable);
    expect(snap.files.seo).toBeUndefined();
    expect(snap.issues).toEqual([expect.objectContaining({ file: "seo", path: "accueil.description" })]);
    expect((await buildSiteSnapshot(oldContract)).issues).toEqual([]);
  });

  it("reprise du site : seo.json et menus.json du dépôt deviennent des documents ; image de partage .jpg reprise du dépôt", async () => {
    const photo = await sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: 30, g: 60, b: 90 } } }).jpeg({ quality: 80 }).toBuffer();
    const sha = createHash("sha256").update(photo).digest("hex").slice(0, 12);
    const seo = { schemaVersion: 1, pages: { faq: { titre: "FAQ | Kouzia", image: `/media/${sha}.jpg` } } };
    const menus = { schemaVersion: 1, pied: [{ cible: "faq" }, { cible: "espaceClient", libelle: "Mon espace" }] };
    await importSiteFiles(raw, new Date(), { seo: JSON.stringify(seo), menus: JSON.stringify(menus) });
    const doc = async (key: string) => JSON.parse((await prisma.siteText.findUniqueOrThrow({ where: { key } })).valueJson);
    expect(await doc("seo")).toEqual({ pages: seo.pages });
    expect(await doc("menus")).toEqual({ pied: menus.pied });

    const read = async (path: string) => (path === `public/media/${sha}.jpg` ? photo : null);
    expect(await adoptMissingMedia(read)).toBe(1);
    expect(await prisma.siteMedia.findUniqueOrThrow({ where: { sha12: sha } })).toMatchObject({ kind: "PARTAGE", width: 1200, height: 630 });
    const snap = await buildSiteSnapshot(contract);
    expect(snap.issues).toEqual([]);
    expect(snap.files.seo).toBe(serializeSiteFile(seo));
    expect(snap.mediaExt[sha]).toBe("jpg");
  });

  it("reprise : fichier facultatif non conforme au contrat du dépôt refusé, rien d'importé", async () => {
    const bad = { schemaVersion: 1, entete: [{ cible: "espaceClient" }] };
    await expect(importSiteFiles(raw, new Date(), { menus: JSON.stringify(bad) }, contract)).rejects.toThrow(/non conforme/);
    expect(await prisma.siteText.count()).toBe(0);
  });

  it("sans document : aucun fichier facultatif, empreinte inchangée", async () => {
    await importSiteFiles(raw);
    const a = await buildSiteSnapshot(oldContract);
    const b = await buildSiteSnapshot(contract);
    expect([b.files.seo, b.files.menus]).toEqual([undefined, undefined]);
    expect(b.digest).toBe(a.digest);
  });
});
