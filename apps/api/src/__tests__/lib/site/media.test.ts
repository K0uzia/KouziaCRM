import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { SiteMediaKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { normalizeSiteImage, parseCropRatio, readSiteMedia, saveSiteImage, SiteMediaError } from "@/lib/site/media.js";
import { resetDb } from "../../helpers/db.js";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

/** Photo de téléphone : JPEG avec EXIF, dont la position GPS. */
async function phonePhoto(width: number, height: number, seed = 0): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30 + seed, g: 90, b: 160 } } })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: { Make: "Samsung", Model: "Galaxy", Artist: "Alexandre" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 22/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "3/1 44/1 0/1" },
    })
    .toBuffer();
}

describe("images de l'espace Site", () => {
  it("capture : WebP 960 et 1920 px de large, ratio d'origine conservé (aucun recadrage), sans métadonnée (EXIF, GPS)", async () => {
    const input = await phonePhoto(2400, 1600);
    expect((await sharp(input).metadata()).exif).toBeDefined();

    // 3:2 reste en 3:2 (décision du 23/10/2026 : plus de cadre 16:9 imposé).
    const media = await saveSiteImage(input, SiteMediaKind.CAPTURE);
    expect(media).toMatchObject({ width: 960, height: 640, width2x: 1920, height2x: 1280, cropRatio: null });
    expect(media.sha12).toMatch(/^[a-f0-9]{12}$/);
    for (const x2 of [false, true]) {
      const out = await readSiteMedia(media.sha12, x2);
      const meta = await sharp(out!).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(out!.toString("latin1")).not.toContain("Samsung");
    }
    expect(media.bytes).toBeLessThanOrEqual(150_000);
    expect(media.bytes2x!).toBeLessThanOrEqual(300_000);
  });

  it("même image envoyée deux fois : une seule entrée", async () => {
    const input = await phonePhoto(1920, 1080);
    const a = await saveSiteImage(input, SiteMediaKind.CAPTURE);
    const b = await saveSiteImage(input, SiteMediaKind.CAPTURE);
    expect(b.id).toBe(a.id);
    expect(await prisma.siteMedia.count()).toBe(1);
  });

  it("source trop petite pour la 2x : version 1x seule ; trop petite pour la 1x : refusée", async () => {
    const media = await saveSiteImage(await phonePhoto(1200, 700, 77), SiteMediaKind.CAPTURE);
    expect(media.width2x).toBeNull();
    expect(await readSiteMedia(media.sha12, true)).toBeNull();
    await expect(saveSiteImage(await phonePhoto(800, 450), SiteMediaKind.CAPTURE)).rejects.toMatchObject({ code: "TOO_SMALL" });
  });

  it("logo : 200 et 400 px de large, sans agrandissement", async () => {
    const png = await sharp({ create: { width: 800, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const media = await saveSiteImage(png, SiteMediaKind.LOGO);
    expect(media).toMatchObject({ width: 200, height: 75, width2x: 400, height2x: 150 });
  });

  it("capture de téléphone 780×1688 : 390×844 et 780×1688 sans recadrage ; page entière : rien de coupé, hauteur bornée à 3 largeurs", async () => {
    const phone = await saveSiteImage(await phonePhoto(780, 1688, 12), SiteMediaKind.MOBILE);
    expect(phone).toMatchObject({ kind: "MOBILE", width: 390, height: 844, width2x: 780, height2x: 1688 });

    // Page longue : 3000 px rouges en haut, puis du bleu. Plus rien n'est coupé : le bleu reste en bas.
    const red = { r: 200, g: 20, b: 20 };
    const input = await sharp({ create: { width: 1170, height: 4000, channels: 3, background: { r: 20, g: 20, b: 200 } } })
      .composite([{ input: { create: { width: 1170, height: 3000, channels: 3, background: red } }, top: 0, left: 0 }])
      .png()
      .toBuffer();
    const media = await saveSiteImage(input, SiteMediaKind.MOBILE);
    // 1170×4000 dépasse 3 largeurs : réduite à 1170 px de haut en 1x, ratio conservé (342 px de large).
    expect(media).toMatchObject({ width: 342, height: 1170, width2x: 684, height2x: 2340 });
    expect(media.bytes2x!).toBeLessThanOrEqual(300_000);
    const out = await readSiteMedia(media.sha12, true);
    const { data, info } = await sharp(out!).raw().toBuffer({ resolveWithObject: true });
    const pixel = (y: number) => [...data.subarray((y * info.width + 10) * info.channels, (y * info.width + 10) * info.channels + 3)];
    expect(pixel(0)[0]).toBeGreaterThan(150);
    expect(pixel(info.height - 1)[2]).toBeGreaterThan(150);
  });

  it("capture de téléphone : 1x seule sous 780 px de large ; refusée sous 390 px de large", async () => {
    const media = await saveSiteImage(await phonePhoto(500, 1100, 41), SiteMediaKind.MOBILE);
    expect(media).toMatchObject({ width: 390, height: 858, width2x: null });
    await expect(saveSiteImage(await phonePhoto(360, 800), SiteMediaKind.MOBILE)).rejects.toMatchObject({ code: "TOO_SMALL" });
  });

  it("recadrage choisi à la main : 16:10 ou ratio d'une autre image, autour du point d'intérêt ; trop serré : refusé", async () => {
    const input = await phonePhoto(2400, 1600, 5);
    expect((await normalizeSiteImage(input, SiteMediaKind.CAPTURE, null, "16:10")).x1).toMatchObject({ width: 960, height: 600 });
    expect((await normalizeSiteImage(input, SiteMediaKind.CAPTURE, { x: 0.5, y: 0.5 }, "1440:900")).x2).toMatchObject({ width: 1920, height: 1200 });
    // Ratio refusé : traité comme le format d'origine.
    expect((await normalizeSiteImage(input, SiteMediaKind.CAPTURE, null, "n'importe quoi")).x1).toMatchObject({ width: 960, height: 640 });
    // 1000×1000 recadré en 16:9 garde 1000×563 : assez large ; 900 px de large ne l'est pas.
    await expect(normalizeSiteImage(await phonePhoto(900, 1800), SiteMediaKind.CAPTURE, null, "16:9")).rejects.toMatchObject({ code: "TOO_SMALL" });
    expect(parseCropRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseCropRatio("1:9")).toBeNull();
  });

  it("image de partage : toujours 1200×630, recadrée", async () => {
    const media = await saveSiteImage(await phonePhoto(2400, 1600, 9), SiteMediaKind.PARTAGE);
    expect(media).toMatchObject({ width: 1200, height: 630, width2x: null });
  });

  it("logo SVG : rastérisé en WebP transparent 200 et 400 px, même dessiné petit", async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 40" width="100" height="40"><defs><linearGradient id="g"><stop offset="0" stop-color="#fe9a00"/><stop offset="1" stop-color="#615fff"/></linearGradient></defs><rect width="100" height="40" rx="6" fill="url(#g)"/><use xlink:href="#g"/></svg>',
    );
    const media = await saveSiteImage(svg, SiteMediaKind.LOGO);
    expect(media).toMatchObject({ width: 200, height: 80, width2x: 400, height2x: 160 });
    const meta = await sharp((await readSiteMedia(media.sha12))!).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.hasAlpha).toBe(true);
  });

  it("SVG qui appelle une ressource externe, un script ou une entité : refusé avant tout rendu ; SVG hors logo refusé", async () => {
    for (const body of [
      '<image href="file:///etc/passwd" width="10" height="10"/>',
      '<image xlink:href="https://exemple.fr/a.png"/>',
      '<script>alert(1)</script>',
      '<style>@import "https://exemple.fr/a.css";</style>',
      '<rect fill="url(https://exemple.fr/a.svg#x)"/>',
      '<foreignObject><div/></foreignObject>',
    ]) {
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200">${body}</svg>`);
      await expect(saveSiteImage(svg, SiteMediaKind.LOGO), body).rejects.toMatchObject({ code: "FORMAT" });
    }
    const entity = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><text>&x;</text></svg>');
    await expect(saveSiteImage(entity, SiteMediaKind.LOGO)).rejects.toMatchObject({ code: "FORMAT" });
    const clean = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#123"/></svg>');
    await expect(saveSiteImage(clean, SiteMediaKind.CAPTURE)).rejects.toMatchObject({ code: "FORMAT" });
  });

  it("image de partage : un JPEG unique de 1200×630, sans métadonnées, fond blanc sous la transparence ; refusée en dessous", async () => {
    const media = await saveSiteImage(await phonePhoto(2400, 1600), SiteMediaKind.PARTAGE);
    expect(media).toMatchObject({ kind: "PARTAGE", width: 1200, height: 630, width2x: null });
    expect(media.bytes).toBeLessThanOrEqual(300_000);
    const out = await readSiteMedia(media.sha12, false, "jpg");
    const meta = await sharp(out!).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(["jpeg", 1200, 630, undefined]);
    expect(await readSiteMedia(media.sha12)).toBeNull();

    const transparent = await sharp({ create: { width: 1200, height: 630, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const flat = await saveSiteImage(transparent, SiteMediaKind.PARTAGE);
    const { data } = await sharp((await readSiteMedia(flat.sha12, false, "jpg"))!).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);

    await expect(saveSiteImage(await phonePhoto(1000, 600), SiteMediaKind.PARTAGE)).rejects.toThrow(/1200×630/);
  });

  it("refuse un fichier qui n'est pas une image, ou un SVG", async () => {
    await expect(saveSiteImage(Buffer.from("pas une image"), SiteMediaKind.LOGO)).rejects.toBeInstanceOf(SiteMediaError);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><script>alert(1)</script></svg>');
    await expect(saveSiteImage(svg, SiteMediaKind.LOGO)).rejects.toMatchObject({ code: "FORMAT" });
  });
});
