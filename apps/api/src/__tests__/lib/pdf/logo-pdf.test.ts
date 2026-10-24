import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { uploadsPath } from "@/lib/uploads.js";
import { loadSharp } from "@/lib/site/media.js";
import { LOGO_MAX_PX, loadBrandLogoDataUrl } from "@/lib/pdf/brand-assets.js";

const DIR = "test-logos";

afterEach(async () => {
  await rm(uploadsPath(DIR), { recursive: true, force: true });
});

/** Image de bruit (lourde à compresser), écrite dans data/uploads ; renvoie son chemin relatif et son poids. */
async function logo(width: number, height: number, format: "png" | "jpeg" | "webp") {
  const sharp = (await loadSharp())!;
  const raw = Buffer.alloc(width * height * 3);
  // Bruit pseudo-aléatoire déterministe : une image réelle se compresse mal, un motif régulier trop bien.
  let seed = width * 31 + height;
  for (let i = 0; i < raw.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    raw[i] = seed >>> 24;
  }
  const img = sharp(raw, { raw: { width, height, channels: 3 } });
  const buffer = format === "png" ? await img.png().toBuffer() : format === "jpeg" ? await img.jpeg().toBuffer() : await img.webp().toBuffer();
  const rel = `${DIR}/logo-${width}x${height}.${format === "jpeg" ? "jpg" : format}`;
  await mkdir(path.dirname(uploadsPath(rel)), { recursive: true });
  await writeFile(uploadsPath(rel), buffer);
  return { rel, bytes: buffer.length };
}

async function decoded(dataUrl: string | null) {
  const [, mime, b64] = /^data:([^;]+);base64,(.+)$/.exec(dataUrl ?? "") ?? [];
  const buffer = Buffer.from(b64 ?? "", "base64");
  const meta = await (await loadSharp())!(buffer).metadata();
  return { mime, bytes: buffer.length, width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe("logo des PDF : 256 px au plus, jamais agrandi", () => {
  it("grand logo PNG : réduit à 256 px de large, proportions gardées, bien plus léger", async () => {
    const { rel, bytes } = await logo(2000, 1000, "png");
    const out = await decoded(await loadBrandLogoDataUrl(rel));
    expect(out).toMatchObject({ mime: "image/png", width: LOGO_MAX_PX, height: 128 });
    expect(out.bytes).toBeLessThan(bytes / 4);
  });

  it("petit logo : jamais agrandi ; JPEG reste JPEG ; WebP converti en PNG", async () => {
    expect(await decoded(await loadBrandLogoDataUrl((await logo(120, 60, "png")).rel))).toMatchObject({ width: 120, height: 60 });
    expect(await decoded(await loadBrandLogoDataUrl((await logo(1200, 1200, "jpeg")).rel))).toMatchObject({ mime: "image/jpeg", width: 256, height: 256 });
    expect(await decoded(await loadBrandLogoDataUrl((await logo(800, 400, "webp")).rel))).toMatchObject({ mime: "image/png", width: 256, height: 128 });
  });

  it("logo absent : null", async () => {
    expect(await loadBrandLogoDataUrl(`${DIR}/absent.png`)).toBeNull();
    expect(await loadBrandLogoDataUrl(null)).toBeNull();
  });
});
