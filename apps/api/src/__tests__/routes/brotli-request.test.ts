import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});

// CVE-2026-111497 (décodeur Brotli de Node, 21/10/2026) : aucun corps de requête n'est décompressé en Brotli.
describe("corps de requête compressés", () => {
  const body = JSON.stringify({ email: "personne@kouzia.test", password: "mauvais-mot-de-passe" });
  const login = (payload: Buffer, encoding: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload,
      headers: { "content-type": "application/json", "content-encoding": encoding },
      remoteAddress: `10.9.${encoding.length}.7`,
    });

  it("Content-Encoding br : refusé en 415, jamais décompressé", async () => {
    const res = await login(brotliCompressSync(Buffer.from(body)), "br");
    expect(res.statusCode).toBe(415);
  });

  it("gzip : toujours accepté (le corps est lu, l'identifiant est simplement faux)", async () => {
    const res = await login(gzipSync(Buffer.from(body)), "gzip");
    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).toBeLessThan(500);
  });
});
