import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { SiteMediaKind, SitePublicationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { SITE_FILES, type SiteFileName } from "@/lib/site/contract.js";
import { importSiteFiles } from "@/lib/site/import.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { recordPublished } from "@/lib/site/changes.js";
import { ORIGINAL_MAX_SIDE, focalCrop, readSiteMedia, saveSiteImage, siteMediaRelativePath, sniffImageType } from "@/lib/site/media.js";
import {
  adoptMissingMedia,
  deleteLibraryMedia,
  listLibrary,
  purgePreviousVersions,
  recropLibraryMedia,
  regenerateFramedCaptures,
} from "@/lib/site/library.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8");
const raw = Object.fromEntries(SITE_FILES.map((n) => [n, fixture(`${n}.json`).replace(/\r\n/g, "\n")])) as Record<SiteFileName, string>;

// Rendu sharp d'images de 3 000 px, et import de toute l'application pour le test de routes : jusqu'à 45 s quand
// toute la suite tourne en parallèle sur une machine chargée (constaté par kouziacrm-b1).
vi.setConfig({ testTimeout: 90_000 });

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await importSiteFiles(raw);
});

/** Publication arrivée dans le dépôt, comme après publishSite (empreintes, fichiers publiés, ménage). */
async function publier() {
  const readAt = new Date();
  const snapshot = await buildSiteSnapshot();
  const row = await prisma.sitePublication.create({ data: { status: SitePublicationStatus.NOOP, digest: snapshot.digest, summaryJson: "[]" } });
  await recordPublished(readAt, snapshot, row.id);
  await purgePreviousVersions();
}

/** Photo de téléphone avec EXIF et GPS : moitié gauche rouge, moitié droite bleue (le recadrage se voit). */
async function photo(width: number, height: number, seed = 0): Promise<Buffer> {
  const half = await sharp({ create: { width: Math.floor(width / 2), height, channels: 3, background: { r: 20, g: 40 + seed, b: 220 } } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 30 + seed, b: 20 } } })
    .composite([{ input: half, left: Math.ceil(width / 2), top: 0 }])
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: { Make: "Samsung", Model: "Galaxy", Artist: "Alexandre" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 22/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "3/1 44/1 0/1" },
    })
    .toBuffer();
}
const exists = (rel: string) => existsSync(issuedPdfAbsolutePath(rel));
const firstProject = () => prisma.siteProject.findFirstOrThrow({ where: { status: "PUBLISHED" }, orderBy: { position: "asc" } });

describe("type réel du fichier", () => {
  it("reconnu par ses premiers octets, quelle que soit l'extension", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#123" } }).png().toBuffer();
    expect(sniffImageType(png)).toBe("png");
    expect(sniffImageType(await sharp(png).jpeg().toBuffer())).toBe("jpeg");
    expect(sniffImageType(await sharp(png).webp().toBuffer())).toBe("webp");
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("svg");
    expect(sniffImageType(Buffer.from("GIF89a..."))).toBeNull();
    expect(sniffImageType(Buffer.from("%PDF-1.7"))).toBeNull();
  });

  it("GIF ou PDF renommé en .png : refusé ; PNG nommé .jpg : accepté (le contenu décide)", async () => {
    const gif = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#345" } }).gif().toBuffer();
    await expect(saveSiteImage(gif, SiteMediaKind.CAPTURE, "capture.png")).rejects.toMatchObject({ code: "FORMAT" });
    await expect(saveSiteImage(Buffer.from("%PDF-1.7\n..."), SiteMediaKind.CAPTURE, "capture.png")).rejects.toMatchObject({ code: "FORMAT" });
    const png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#456" } }).png().toBuffer();
    const media = await saveSiteImage(png, SiteMediaKind.CAPTURE, "capture.jpg");
    expect(media.originalPath).toMatch(/\.png$/);
  });
});

describe("original conservé", () => {
  it("sans EXIF ni GPS, orientation appliquée, plus grand côté borné ; nom lisible repris du fichier", async () => {
    const media = await saveSiteImage(await photo(5000, 3000), SiteMediaKind.CAPTURE, "IMG_2041.jpeg");
    expect(media).toMatchObject({ label: "IMG_2041", originalName: "IMG_2041.jpeg" });
    const original = readFileSync(issuedPdfAbsolutePath(media.originalPath!));
    expect(media.originalBytes).toBe(original.length);
    const meta = await sharp(original).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(original.toString("latin1")).not.toContain("Samsung");
    expect(Math.max(meta.width!, meta.height!)).toBe(ORIGINAL_MAX_SIDE);
  });

  it("image déjà connue sans original (avant la médiathèque) : le renvoi lui rend son original", async () => {
    const input = await photo(1920, 1080, 5);
    const media = await saveSiteImage(input, SiteMediaKind.CAPTURE);
    await prisma.siteMedia.update({ where: { id: media.id }, data: { originalPath: null, originalBytes: null, label: null } });
    const again = await saveSiteImage(input, SiteMediaKind.CAPTURE, "accueil.jpg");
    expect(again.id).toBe(media.id);
    expect(again).toMatchObject({ label: "accueil" });
    expect(exists(again.originalPath!)).toBe(true);
  });
});

describe("recadrage et images en ligne", () => {
  it("zone gardée centrée sur le point d'intérêt, sans sortir de l'image", () => {
    expect(focalCrop(3000, 1080, 16 / 9, { x: 0, y: 0.5 })).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(focalCrop(3000, 1080, 16 / 9, { x: 1, y: 0.5 })).toEqual({ left: 1080, top: 0, width: 1920, height: 1080 });
    expect(focalCrop(1920, 3000, 16 / 9, { x: 0.5, y: 0.5 })).toEqual({ left: 0, top: 960, width: 1920, height: 1080 });
  });

  it("recadrer une image en ligne : nouvelle version, fiche repointée, ancienne gardée jusqu'à la publication suivante", async () => {
    const media = await saveSiteImage(await photo(3000, 1080), SiteMediaKind.CAPTURE, "boutique.jpg");
    const projet = await firstProject();
    await prisma.siteProject.update({ where: { id: projet.id }, data: { imagePath: `/media/${media.sha12}.webp` } });
    await publier();

    // Capture : recadrage choisi à la main (16:9), autour du point d'intérêt.
    const gauche = await recropLibraryMedia(media.id, { x: 0, y: 0.5 }, "16:9");
    expect(gauche.sha12).not.toBe(media.sha12);
    expect(gauche).toMatchObject({ focalX: 0, focalY: 0.5, cropRatio: "16:9", width: 960, height: 540, label: "boutique", originalPath: media.originalPath });
    const pixel = await sharp((await readSiteMedia(gauche.sha12))!).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(150); // rouge : moitié gauche gardée
    expect((await prisma.siteProject.findUniqueOrThrow({ where: { id: projet.id } })).imagePath).toBe(`/media/${gauche.sha12}.webp`);

    // L'ancienne version est encore celle de kouzia.com : gardée, fichiers compris, et non supprimable.
    const avant = await listLibrary();
    expect(avant.find((m) => m.id === media.id)).toMatchObject({ previousVersion: true, online: true, usages: [] });
    expect(avant.find((m) => m.id === gauche.id)).toMatchObject({ online: false, previousVersion: false });
    await expect(deleteLibraryMedia(media.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Encore en ligne") });
    expect(await readSiteMedia(media.sha12)).not.toBeNull();

    // Publication suivante : la nouvelle version est en ligne, l'ancienne disparaît ; l'original partagé reste.
    await publier();
    expect(await prisma.siteMedia.findUnique({ where: { id: media.id } })).toBeNull();
    expect(exists(siteMediaRelativePath(media.sha12))).toBe(false);
    expect(exists(siteMediaRelativePath(media.sha12, true))).toBe(false);
    expect(exists(gauche.originalPath!)).toBe(true);
  });

  it("recadrer une image hors ligne : l'ancienne version disparaît aussitôt ; logo et image sans original refusés", async () => {
    const media = await saveSiteImage(await photo(3000, 1080, 9), SiteMediaKind.CAPTURE, "brouillon.jpg");
    const droite = await recropLibraryMedia(media.id, { x: 1, y: 0.5 }, "16:9");
    expect(await prisma.siteMedia.findUnique({ where: { id: media.id } })).toBeNull();
    expect(exists(siteMediaRelativePath(media.sha12))).toBe(false);
    expect(exists(droite.originalPath!)).toBe(true);

    const logo = await saveSiteImage(await sharp({ create: { width: 400, height: 200, channels: 4, background: "#0000" } }).png().toBuffer(), SiteMediaKind.LOGO);
    await expect(recropLibraryMedia(logo.id, { x: 0.5, y: 0.5 })).rejects.toMatchObject({ code: "FORMAT" });
    await prisma.siteMedia.update({ where: { id: droite.id }, data: { originalPath: null } });
    await expect(recropLibraryMedia(droite.id, { x: 0.5, y: 0.5 }, "16:9")).rejects.toMatchObject({ message: expect.stringContaining("Original non conservé") });
  });
});

describe("doublons", () => {
  it("même fichier renvoyé après un recadrage : la version recadrée revient, aucune nouvelle image", async () => {
    const input = await photo(3000, 1080, 11);
    const media = await saveSiteImage(input, SiteMediaKind.CAPTURE, "vitrine.jpg");
    const recadree = await recropLibraryMedia(media.id, { x: 0, y: 0.5 }, "16:9");
    const encore = await saveSiteImage(input, SiteMediaKind.CAPTURE, "vitrine.jpg");
    expect(encore.id).toBe(recadree.id);
    expect(await prisma.siteMedia.count()).toBe(1);
  });

  it("ancienne version en ligne : signalée comme telle, même si aucune version n'est utilisée", async () => {
    const media = await saveSiteImage(await photo(3000, 1080, 12), SiteMediaKind.CAPTURE);
    const projet = await firstProject();
    await prisma.siteProject.update({ where: { id: projet.id }, data: { imagePath: `/media/${media.sha12}.webp` } });
    await publier();
    const recadree = await recropLibraryMedia(media.id, { x: 1, y: 0.5 });
    await prisma.siteProject.update({ where: { id: projet.id }, data: { imagePath: projet.imagePath } });
    const liste = await listLibrary();
    expect(liste.find((m) => m.id === media.id)).toMatchObject({ previousVersion: true, online: true });
    expect(liste.find((m) => m.id === recadree.id)).toMatchObject({ previousVersion: false });
  });
});

describe("suppression", () => {
  it("refusée si utilisée ; sinon 1x, 2x et original supprimés", async () => {
    await publier();
    const media = await saveSiteImage(await photo(2000, 1200, 3), SiteMediaKind.CAPTURE, "essai.jpg");
    const projet = await firstProject();
    await prisma.siteProject.update({ where: { id: projet.id }, data: { imagePath: `/media/${media.sha12}.webp` } });
    await expect(deleteLibraryMedia(media.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(projet.name) });

    await prisma.siteProject.update({ where: { id: projet.id }, data: { imagePath: projet.imagePath } });
    await deleteLibraryMedia(media.id);
    expect(await prisma.siteMedia.count({ where: { id: media.id } })).toBe(0);
    for (const rel of [siteMediaRelativePath(media.sha12), siteMediaRelativePath(media.sha12, true), media.originalPath!]) {
      expect(exists(rel), rel).toBe(false);
    }
  });

  it("site publié avant le suivi des fichiers : suppression refusée tant qu'on ne sait pas ce qui est en ligne", async () => {
    await prisma.sitePublication.create({ data: { status: SitePublicationStatus.LIVE, digest: "ancien", summaryJson: "[]", commitSha: "abc" } });
    const media = await saveSiteImage(await photo(2000, 1200, 4), SiteMediaKind.CAPTURE);
    await expect(deleteLibraryMedia(media.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("publier une fois") });
  });
});

describe("reprise du site", () => {
  it("image citée mais absente de l'ERP : copiée depuis le dépôt si son contenu correspond à son nom", async () => {
    const source = await saveSiteImage(await photo(2000, 1200, 6), SiteMediaKind.CAPTURE);
    const x1 = (await readSiteMedia(source.sha12))!;
    const x2 = await readSiteMedia(source.sha12, true);
    await prisma.siteMedia.delete({ where: { id: source.id } });
    const projet = await firstProject();
    await prisma.siteProject.update({
      where: { id: projet.id },
      data: { imagePath: `/media/${source.sha12}.webp`, imageMobilePath: "/media/0123456789ab.webp" },
    });
    expect((await buildSiteSnapshot()).issues.filter((i) => i.message.startsWith("Image absente"))).toHaveLength(2);

    const repo: Record<string, Buffer | null> = {
      [`public/media/${source.sha12}.webp`]: x1,
      [`public/media/${source.sha12}-2x.webp`]: x2,
      // Contenu qui ne correspond pas au nom : ignoré.
      "public/media/0123456789ab.webp": x1,
    };
    expect(await adoptMissingMedia(async (p) => repo[p] ?? null)).toBe(1);
    const adopted = await prisma.siteMedia.findUniqueOrThrow({ where: { sha12: source.sha12 } });
    expect(adopted).toMatchObject({ kind: "CAPTURE", width: 960, width2x: 1920, originalPath: null, label: `Capture de « ${projet.name} »` });
    const issues = (await buildSiteSnapshot()).issues.filter((i) => i.message.startsWith("Image absente"));
    expect(issues).toEqual([expect.objectContaining({ file: "realisations", path: `capture de téléphone de « ${projet.name} »` })]);
  });
});

describe("routes de la médiathèque", () => {
  const ADMIN = "admin-site-media@kouzia.test";
  const PASSWORD = "mot-de-passe-de-test";

  it("liste, nom lisible, original, recadrage et suppression", async () => {
    const { hashPassword, SESSION_COOKIE } = await import("@/lib/auth.js");
    const { buildApp } = await import("@/app.js");
    const app = await buildApp({ silent: true, serveStatic: false });
    try {
      await prisma.user.deleteMany({ where: { email: ADMIN } });
      await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
      const cookie = `${SESSION_COOKIE}=${login.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
      const media = await saveSiteImage(await photo(3000, 1080, 8), SiteMediaKind.CAPTURE, "vitrine.jpg");
      expect((await app.inject({ method: "DELETE", url: `/api/site/media/${media.id}` })).statusCode).toBe(401);

      const liste = (await app.inject({ method: "GET", url: "/api/site/media", headers: { cookie } })).json();
      expect(liste[0]).toMatchObject({ id: media.id, label: "vitrine", path: `/media/${media.sha12}.webp`, usages: [], online: false });

      const renamed = await app.inject({ method: "PATCH", url: `/api/site/media/${media.id}`, headers: { cookie }, payload: { label: "Vitrine, accueil" } });
      expect(renamed.json()).toMatchObject({ label: "Vitrine, accueil" });

      const original = await app.inject({ method: "GET", url: `/api/site/media/${media.id}/original`, headers: { cookie } });
      expect(original.statusCode).toBe(200);
      expect(original.headers["content-type"]).toBe("image/jpeg");

      expect((await app.inject({ method: "POST", url: `/api/site/media/${media.id}/recadrage`, headers: { cookie }, payload: { x: 2, y: 0 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/site/media/${media.id}/recadrage`, headers: { cookie }, payload: { ratio: "16-9" } })).statusCode).toBe(400);
      const recadree = await app.inject({ method: "POST", url: `/api/site/media/${media.id}/recadrage`, headers: { cookie }, payload: { x: 1, y: 0.5, ratio: "16:9" } });
      expect(recadree.statusCode).toBe(200);
      const next = recadree.json() as { id: string; path: string };
      expect(next.path).toMatch(/^\/media\/[a-f0-9]{12}\.webp$/);

      expect((await app.inject({ method: "DELETE", url: `/api/site/media/${media.id}`, headers: { cookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/site/media/${next.id}`, headers: { cookie } })).statusCode).toBe(204);
    } finally {
      await app.close();
    }
  });
});

describe("page projet : captures et avant / après (correctif du 23/10/2026)", () => {
  const capture = (sha12: string, vue?: "mobile") => ({ image: `/media/${sha12}.webp`, alt: "Accueil", ...(vue ? { vue } : {}) });

  it("utilisées par les captures et l'avant / après : comptées, non supprimables, format de l'autre image proposé", async () => {
    const a = await saveSiteImage(await photo(1440, 900, 21), SiteMediaKind.CAPTURE, "avant.jpg");
    const b = await saveSiteImage(await photo(1440, 920, 22), SiteMediaKind.CAPTURE, "apres.jpg");
    const c = await saveSiteImage(await photo(780, 1688, 23), SiteMediaKind.MOBILE, "mobile.jpg");
    const projet = await firstProject();
    await prisma.siteProject.update({
      where: { id: projet.id },
      data: {
        capturesJson: JSON.stringify([capture(c.sha12, "mobile")]),
        avantApresJson: JSON.stringify([
          { vue: "bureau", avant: { image: `/media/${a.sha12}.webp`, alt: "Avant", date: "2020-01" }, apres: { image: `/media/${b.sha12}.webp`, alt: "Après" } },
        ]),
      },
    });
    const items = await listLibrary();
    const of = (id: string) => items.find((m) => m.id === id)!;
    expect(of(c.id).usages).toEqual([expect.objectContaining({ field: "captures", mediaKind: "MOBILE" })]);
    expect(of(a.id).usages).toEqual([expect.objectContaining({ field: "avantApres", pairPath: `/media/${b.sha12}.webp` })]);
    expect(of(a.id).pairFormats).toEqual([expect.objectContaining({ ratio: `${b.width}:${b.height}` })]);
    await expect(deleteLibraryMedia(c.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("page projet") });

    // Recadrage au format de l'autre image : les deux ont le même ratio, et la paire est repointée.
    const aligned = await recropLibraryMedia(a.id, null, `${b.width}:${b.height}`);
    expect(aligned.width * b.height).toBe(b.width * aligned.height);
    const after = await prisma.siteProject.findUniqueOrThrow({ where: { id: projet.id } });
    expect(after.avantApresJson).toContain(`/media/${aligned.sha12}.webp`);
    expect(after.avantApresJson).not.toContain(`/media/${a.sha12}.webp`);
  });

  it("captures coupées d'office en 16:9 : signalées, puis régénérées sans recadrage depuis l'original, fiches repointées", async () => {
    const media = await saveSiteImage(await photo(1440, 900, 31), SiteMediaKind.CAPTURE, "ancienne.jpg");
    // Version produite avant le correctif : cadre figé 960×540.
    await prisma.siteMedia.update({ where: { id: media.id }, data: { width: 960, height: 540 } });
    const sansOriginal = await saveSiteImage(await photo(1600, 1000, 32), SiteMediaKind.CAPTURE);
    await prisma.siteMedia.update({ where: { id: sansOriginal.id }, data: { width: 960, height: 540, originalPath: null } });
    const projet = await firstProject();
    await prisma.siteProject.update({ where: { id: projet.id }, data: { imagePath: `/media/${media.sha12}.webp`, capturesJson: JSON.stringify([capture(media.sha12)]) } });

    const flagged = (await listLibrary()).filter((m) => m.regenerable).map((m) => m.id);
    expect(flagged).toEqual([media.id]);
    expect(await regenerateFramedCaptures()).toBe(1);
    const next = await prisma.siteMedia.findFirstOrThrow({ where: { originalPath: media.originalPath, id: { not: media.id } } });
    expect(next).toMatchObject({ width: 960, height: 600, cropRatio: null });
    const after = await prisma.siteProject.findUniqueOrThrow({ where: { id: projet.id } });
    expect(after.imagePath).toBe(`/media/${next.sha12}.webp`);
    expect(after.capturesJson).toContain(`/media/${next.sha12}.webp`);
    expect((await listLibrary()).some((m) => m.regenerable)).toBe(false);
  });
});
