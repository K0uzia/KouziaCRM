import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { BrotliResponseError, installNoBrotliFetch } from "@/lib/http/no-brotli-fetch.js";

let server: Server;
let base = "";
let lastAcceptEncoding: string | undefined;

beforeAll(async () => {
  installNoBrotliFetch();
  server = createServer((req, res) => {
    lastAcceptEncoding = req.headers["accept-encoding"];
    const body = Buffer.from(JSON.stringify({ ok: true }));
    if (req.url === "/br") {
      // Service qui envoie du Brotli sans qu'on le demande.
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "br" });
      res.end(brotliCompressSync(body));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gzipSync(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// CVE-2026-111497 : fetch du serveur sans Brotli.
describe("fetch sortant sans Brotli", () => {
  it("demande gzip ou deflate seulement, même si l'appelant demandait br", async () => {
    const res = await fetch(`${base}/gzip`, { headers: { "accept-encoding": "br, gzip" } });
    expect(lastAcceptEncoding).toBe("gzip, deflate");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("réponse annoncée en br : refusée, corps non lu", async () => {
    await expect(fetch(`${base}/br`)).rejects.toBeInstanceOf(BrotliResponseError);
  });
});
