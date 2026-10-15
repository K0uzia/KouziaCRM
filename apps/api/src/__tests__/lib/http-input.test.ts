import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { idParams } from "@/lib/http-input.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
let app: FastifyInstance;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

describe("entrées de l'URL validées par zod (socle de toutes les routes /api)", () => {
  it("schéma partagé idParams", () => {
    expect(idParams.safeParse({ id: "cmv9zko37000dzwb8jjgmredf" }).success).toBe(true);
    for (const id of ["", "a b", "x".repeat(257), "../etc", "<script>"]) expect(idParams.safeParse({ id }).success, id).toBe(false);
  });

  it("paramètre de route invalide : 404 identique à une ressource inconnue, avant tout code de la route", async () => {
    for (const url of ["/api/public/documents/abc%20def", "/api/public/receipts/%3Cscript%3E", "/api/public/pay/a%2Fb"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: "Not found" });
    }
  });

  it("requête : clé répétée, valeur trop longue ou caractère de contrôle refusés (400) ; requête normale acceptée", async () => {
    for (const url of ["/api/health?a=1&a=2", `/api/health?x=${"y".repeat(2001)}`, "/api/health?x=a%00b"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/api/health?x=1" })).statusCode).toBe(200);
  });
});
