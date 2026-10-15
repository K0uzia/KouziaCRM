import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getAllowedOrigins } from "@/lib/env.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const FOREIGN = "https://attaquant.example";
let dev: FastifyInstance;
let prod: FastifyInstance;
let allowed: string;

beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  allowed = getAllowedOrigins()[0]!;
  dev = await buildApp({ silent: true, serveStatic: false });
  // Production : la règle « ni Origin ni Referer » est lue au démarrage du plugin.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    prod = await buildApp({ silent: true, serveStatic: false });
  } finally {
    process.env.NODE_ENV = previous;
  }
});
afterAll(async () => {
  await dev.close();
  await prod.close();
  await resetDb();
});

// Une IP par requête : la limite de débit des routes publiques n'interfère pas.
let n = 0;
const call = (app: FastifyInstance, method: "GET" | "POST", url: string, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined, remoteAddress: `10.9.${Math.floor(++n / 250)}.${n % 250}` });

describe("garde d'origine (CSRF, défense en profondeur)", () => {
  it("origine étrangère refusée (403) sur une mutation admin et une mutation publique, par Origin comme par Referer", async () => {
    for (const url of ["/api/auth/logout", "/api/public/auth/logout", "/api/public/auth/code"]) {
      expect((await call(dev, "POST", url, { origin: FOREIGN })).statusCode, url).toBe(403);
      expect((await call(dev, "POST", url, { referer: `${FOREIGN}/page` })).statusCode, url).toBe(403);
    }
    // Origine opaque (iframe sandbox, fichier local) : refusée.
    expect((await call(dev, "POST", "/api/auth/logout", { origin: "null" })).statusCode).toBe(403);
    expect((await call(dev, "POST", "/api/auth/logout", { referer: "pas une adresse" })).statusCode).toBe(403);
  });

  it("origine autorisée ou même origine (admin en LAN ou Tailscale, page servie par l'API) : acceptée", async () => {
    expect((await call(dev, "POST", "/api/auth/logout", { origin: allowed })).statusCode).not.toBe(403);
    expect((await call(dev, "POST", "/api/public/auth/logout", { origin: allowed })).statusCode).not.toBe(403);
    expect((await call(dev, "POST", "/api/auth/logout", { referer: `${allowed}/settings` })).statusCode).not.toBe(403);
    expect((await call(dev, "POST", "/api/auth/logout", { origin: "http://192.168.1.52:3000", host: "192.168.1.52:3000" })).statusCode).not.toBe(403);
    // Même hôte mais origine différente (autre port) : ce n'est pas la même origine.
    expect((await call(dev, "POST", "/api/auth/logout", { origin: "http://192.168.1.52:8080", host: "192.168.1.52:3000" })).statusCode).toBe(403);
  });

  it("lectures (GET) non concernées", async () => {
    expect((await call(dev, "GET", "/api/health", { origin: FOREIGN })).statusCode).toBe(200);
  });

  it("exemptions explicites : webhooks et liens de paiement, sans Origin ni Referer, même en production", async () => {
    for (const app of [dev, prod]) {
      expect((await call(app, "POST", "/api/webhooks/stripe", { origin: FOREIGN })).statusCode).not.toBe(403);
      expect((await call(app, "POST", "/api/webhooks/stripe")).statusCode).not.toBe(403);
      expect((await call(app, "POST", "/api/public/pay/jeton-inconnu")).statusCode).not.toBe(403);
    }
  });

  it("production : mutation sans Origin ni Referer refusée ; en dev, tolérée (curl)", async () => {
    expect((await call(prod, "POST", "/api/auth/logout")).statusCode).toBe(403);
    expect((await call(prod, "POST", "/api/public/auth/logout")).statusCode).toBe(403);
    expect((await call(prod, "POST", "/api/auth/logout", { origin: allowed })).statusCode).not.toBe(403);
    expect((await call(dev, "POST", "/api/auth/logout")).statusCode).not.toBe(403);
  });
});
