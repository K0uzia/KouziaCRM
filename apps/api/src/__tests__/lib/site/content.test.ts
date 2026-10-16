import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SiteAuthorizationScope, SiteItemStatus, SiteReferenceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { SITE_FILES, serializeSiteFile, validateSiteFiles, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles, SiteImportError } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Fichiers réels du site (KouziaWebsite, src/content/site, main 600dec6) : le contrat et son export.
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

  it("mention sous le projet : juste après sousTitre (ou nom), omise si vide, reprise à l'identique ; 61 caractères, vide ou tiret long refusés", async () => {
    const MENTION = "Développé par Kouzia au sein de La Capsule";
    const files = parsed();
    const byId = (id: string) => files.realisations.realisations.find((r: { id: string }) => r.id === id);
    // Clés réinsérées dans l'ordre du contrat du site.
    const withMention = (r: Record<string, unknown>, after: string) =>
      Object.fromEntries(Object.entries(r).flatMap(([k, v]) => (k === after ? [[k, v], ["mention", MENTION]] : [[k, v]])));
    const list = files.realisations.realisations as Array<Record<string, unknown>>;
    list[list.indexOf(byId("la-capsule"))] = withMention(byId("la-capsule"), "sousTitre");
    list[list.indexOf(byId("capsuleos"))] = withMention(byId("capsuleos"), "nom");
    const withFile = { ...raw, realisations: serializeSiteFile(files.realisations) };
    expect(validateSiteFiles({ ...parsed(), realisations: files.realisations }, contract)).toEqual([]);

    await importSiteFiles(withFile);
    expect((await prisma.siteProject.findUniqueOrThrow({ where: { slug: "la-capsule" } })).mention).toBe(MENTION);
    expect((await prisma.siteProject.findUniqueOrThrow({ where: { slug: "tracebay" } })).mention).toBeNull();
    const snap = await buildSiteSnapshot(contract);
    expect(snap.issues).toEqual([]);
    expect(snap.files.realisations).toBe(withFile.realisations);
    const out = JSON.parse(snap.files.realisations).realisations as Array<Record<string, unknown>>;
    const keys = (id: string) => Object.keys(out.find((r) => r.id === id)!);
    expect(keys("la-capsule").slice(0, 5)).toEqual(["id", "nom", "sousTitre", "mention", "type"]);
    expect(keys("capsuleos").slice(0, 4)).toEqual(["id", "nom", "mention", "type"]);
    expect(keys("tracebay")).not.toContain("mention");

    for (const mention of ["x".repeat(61), "Kouzia \u2014 La Capsule", ""]) {
      const bad = parsed();
      bad.realisations.realisations[0].mention = mention;
      expect(validateSiteFiles(bad, contract).length, JSON.stringify(mention)).toBeGreaterThan(0);
      expect(validateSiteFiles(bad).length, JSON.stringify(mention)).toBeGreaterThan(0);
    }
  });

  it("textes alternatifs (contrat 5edecfc) : imageAlt après imageMobile, \"\" = décorative, absent = calcul du site ; logoAlt jamais vide ; refusés par le contrat en ligne avec un message clair", async () => {
    // Contrat du site avec imageAlt et logoAlt (KouziaWebsite, integration ff2e9f3) ; `contract` reste celui en ligne.
    const nouveau = JSON.parse(fixture("contenu.schema.textes-alternatifs.json")) as unknown;
    const ALT = "Page d'accueil du site de La Capsule, réservation de salles";
    await importSiteFiles(raw);
    await prisma.siteProject.update({ where: { slug: "la-capsule" }, data: { imageAlt: ALT } });
    await prisma.siteProject.update({ where: { slug: "tracebay" }, data: { imageAlt: "" } });

    const snap = await buildSiteSnapshot(nouveau);
    expect(snap.issues).toEqual([]);
    const out = JSON.parse(snap.files.realisations).realisations as Array<Record<string, unknown>>;
    const byId = (id: string) => out.find((r) => r.id === id)!;
    expect(byId("la-capsule").imageAlt).toBe(ALT);
    expect(byId("tracebay").imageAlt).toBe("");
    expect(byId("capsuleos")).not.toHaveProperty("imageAlt");
    const keys = Object.keys(byId("tracebay"));
    expect(keys.indexOf("imageAlt")).toBe(keys.indexOf(keys.includes("imageMobile") ? "imageMobile" : "image") + 1);

    // Reprise : un fichier du site avec ces clés revient à l'identique.
    await resetDb();
    await seedCompanySettings();
    const repris = { ...raw, realisations: snap.files.realisations };
    await importSiteFiles(repris);
    expect((await prisma.siteProject.findUniqueOrThrow({ where: { slug: "tracebay" } })).imageAlt).toBe("");
    expect((await prisma.siteProject.findUniqueOrThrow({ where: { slug: "capsuleos" } })).imageAlt).toBeNull();
    expect((await buildSiteSnapshot(nouveau)).files.realisations).toBe(repris.realisations);

    // Site en ligne pas encore à jour : blocage avec ce qu'il faut faire, jamais un message technique.
    const enLigne = (await buildSiteSnapshot(contract)).issues.filter((i) => i.message.includes("pas encore pris en charge"));
    expect(enLigne.length).toBeGreaterThan(0);
    expect(enLigne[0]!.message).toMatch(/^Contrat du site : imageAlt pas encore pris en charge par kouzia\.com ; mettre le site à jour/);

    // Logo : texte alternatif après logo, jamais vide ni plus long que 120 caractères.
    const refs = parsed().references;
    const avecLogo = { id: "asso", type: "CLIENT", nom: "Asso", logo: "/media/0123456789ab.webp", logoAlt: "Asso, association de quartier", url: "https://asso.example", emplacements: ["accueil"] };
    const files = (r: unknown) => ({ ...parsed(), references: { ...refs, references: [...refs.references, r] } });
    expect(validateSiteFiles(files(avecLogo), nouveau)).toEqual([]);
    expect(validateSiteFiles(files({ ...avecLogo, logoAlt: "" }), nouveau).length).toBeGreaterThan(0);
    expect(validateSiteFiles(files({ ...avecLogo, logoAlt: "x".repeat(121) }), nouveau).length).toBeGreaterThan(0);
    expect(validateSiteFiles(files({ ...avecLogo, logoAlt: "" })).length).toBeGreaterThan(0);
    for (const bad of ["x".repeat(201), "  ", "Accueil \u2014 La Capsule"]) {
      const f = parsed();
      f.realisations.realisations[0].imageAlt = bad;
      expect(validateSiteFiles(f, nouveau).length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect(validateSiteFiles(f).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
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
    expect(snap.issues).toContainEqual({ file: "realisations", path: expect.stringContaining("capture de téléphone"), message: expect.stringMatching(/^Image absente de l'ERP \(0123456789ab\) : la renvoyer/) });
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

  it("avis et mur de logos (contrat 600dec6) : clés dans l'ordre du site, avis du plus récent au plus ancien, reprise à l'identique", async () => {
    await importSiteFiles(raw);
    const client = await createClient({ displayName: "Lou Martin" });
    const consent = { consentAt: new Date("2026-10-02T10:00:00Z"), clientId: client.id, status: SiteItemStatus.PUBLISHED };
    await prisma.siteReview.create({ data: { ...consent, author: "Lou M.", reviewedOn: "2026-09-01", experienceOn: "2026-08-20", text: "Ancien." } });
    await prisma.siteReview.create({ data: { ...consent, author: "Ana B.", reviewedOn: "2026-10-01", experienceOn: "2026-09-25", text: "Récent." } });
    await prisma.siteMedia.create({ data: { sha12: "0123456789ab", kind: "LOGO", width: 200, height: 80, bytes: 1000 } });
    await prisma.siteReference.create({
      data: {
        status: SiteItemStatus.PUBLISHED,
        slug: "mairie",
        type: SiteReferenceType.CLIENT,
        name: "Mairie de Huelgoat",
        logoPath: "/media/0123456789ab.webp",
        url: "https://huelgoat.example.fr/",
        productSlug: "morlaix-communaute",
        onHome: true,
        onProjects: true,
        authorizationAt: new Date(),
        authorizationScope: SiteAuthorizationScope.NAME_LOGO,
      },
    });

    // Sans méthode : la publication des avis est bloquée (règle du site reprise par l'ERP).
    const blocked = await buildSiteSnapshot(contract);
    expect(blocked.issues.map((i) => i.message)).toContain("Méthode de recueil et de vérification requise dès qu'un avis est publié");

    await prisma.siteText.create({
      data: { key: "avisMethode", valueJson: JSON.stringify({ titre: "Comment les avis sont recueillis et vérifiés", texte: "Clients vérifiés." }) },
    });
    const snap = await buildSiteSnapshot(contract);
    expect(snap.issues).toEqual([]);
    const avis = JSON.parse(snap.files.avis);
    expect(Object.keys(avis)).toEqual(["schemaVersion", "methode", "avis"]);
    expect(avis.avis.map((a: { auteur: string }) => a.auteur)).toEqual(["Ana B.", "Lou M."]);
    expect(Object.keys(avis.avis[0])).toEqual(["auteur", "publieLe", "experienceLe", "texte"]);
    const [ref] = JSON.parse(snap.files.references).references;
    expect(ref).toEqual({
      id: "mairie",
      type: "CLIENT",
      nom: "Mairie de Huelgoat",
      logo: "/media/0123456789ab.webp",
      url: "https://huelgoat.example.fr/",
      emplacements: ["accueil", "realisations"],
      realisation: "morlaix-communaute",
    });
    expect(Object.keys(ref)).toEqual(["id", "type", "nom", "logo", "url", "emplacements", "realisation"]);
    expect(snap.media).toEqual(["0123456789ab"]);

    // Les fichiers produits se reprennent à l'identique (méthode, dates d'expérience, emplacements, réalisation liée).
    await resetDb();
    await seedCompanySettings();
    await importSiteFiles({ ...raw, avis: snap.files.avis, references: snap.files.references });
    await prisma.siteMedia.create({ data: { sha12: "0123456789ab", kind: "LOGO", width: 200, height: 80, bytes: 1000 } });
    const again = await buildSiteSnapshot(contract);
    expect(again.files.avis).toBe(snap.files.avis);
    expect(again.files.references).toBe(snap.files.references);
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
    expect(messages.some((m) => m.startsWith("Image absente de l'ERP"))).toBe(true);
  });
});
