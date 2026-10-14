import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { SiteMediaKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { readSiteMedia, saveSiteImage, SiteMediaError } from "@/lib/site/media.js";
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
  it("capture : WebP 960×540 et 1920×1080, sans aucune métadonnée (EXIF, GPS)", async () => {
    const input = await phonePhoto(2400, 1600);
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const media = await saveSiteImage(input, SiteMediaKind.CAPTURE);
    expect(media).toMatchObject({ width: 960, height: 540, width2x: 1920, height2x: 1080 });
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

  it("refuse un fichier qui n'est pas une image, ou un SVG", async () => {
    await expect(saveSiteImage(Buffer.from("pas une image"), SiteMediaKind.LOGO)).rejects.toBeInstanceOf(SiteMediaError);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><script>alert(1)</script></svg>');
    await expect(saveSiteImage(svg, SiteMediaKind.LOGO)).rejects.toMatchObject({ code: "FORMAT" });
  });
});
