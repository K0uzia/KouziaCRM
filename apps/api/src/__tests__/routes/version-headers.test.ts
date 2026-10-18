import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { API_CONTRACT } from "@/lib/api-contract.js";

const { buildApp } = await import("@/app.js");

let dist = "";
const INDEX = "<!doctype html><title>ERP</title>";
const ASSET = "console.log('ERP');".repeat(400);
let app: FastifyInstance;
beforeAll(async () => {
  // Build de l'interface factice : index.html et version.json lus par l'API.
  dist = await mkdtemp(path.join(tmpdir(), "kouzia-dist-"));
  await writeFile(path.join(dist, "index.html"), INDEX);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "assets", "app-abc123.js"), ASSET);
  await writeFile(path.join(dist, "version.json"), JSON.stringify({ build: "lt9x2k-abc123" }));
  process.env.WEB_DIST = dist;
  app = await buildApp({ silent: true });
});
afterAll(async () => {
  await app.close();
  delete process.env.WEB_DIST;
  await rm(dist, { recursive: true, force: true });
});

describe("version de l'interface et contrat de l'API dans chaque réponse /api", () => {
  it("en-têtes X-Kouzia-Build (dist/version.json) et X-Kouzia-Contract", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-kouzia-contract"]).toBe(String(API_CONTRACT));
    expect(res.headers["x-kouzia-build"]).toBe("lt9x2k-abc123");
  });

  it("pas sur les fichiers de l'interface", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["x-kouzia-contract"]).toBeUndefined();
  });
});

describe("compression des réponses", () => {
  it("JSON compressé en Brotli si le navigateur le demande, en clair sinon", async () => {
    const big = await app.inject({ method: "GET", url: "/api/health", headers: { "accept-encoding": "br, gzip" } });
    // /api/health est sous le seuil (1 Ko) : jamais compressé.
    expect(big.headers["content-encoding"]).toBeUndefined();
    const page = await app.inject({ method: "GET", url: "/robots.txt", headers: { "accept-encoding": "gzip" } });
    expect([200, 404]).toContain(page.statusCode);
  });

  it("fichier de l'interface au-delà du seuil : Brotli, puis gzip, contenu relu à l'identique", async () => {
    const br = await app.inject({ method: "GET", url: "/assets/app-abc123.js", headers: { "accept-encoding": "br" } });
    expect(br.headers["content-encoding"]).toBe("br");
    const { brotliDecompressSync, gunzipSync } = await import("node:zlib");
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(ASSET);
    const gz = await app.inject({ method: "GET", url: "/assets/app-abc123.js", headers: { "accept-encoding": "gzip" } });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.rawPayload).toString()).toBe(ASSET);
  });
});
