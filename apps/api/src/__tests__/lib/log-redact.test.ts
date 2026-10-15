import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { redactUrl } from "@/lib/log-redact.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const lines: string[] = [];
let app: FastifyInstance;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ serveStatic: false, logStream: { write: (line) => void lines.push(line) } });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

const TOKEN = "eyJkIjoiY2xpZW50In0.c2lnbmF0dXJlLXNlY3JldGU";

describe("journaux sans jeton", () => {
  it.each([
    [`/api/public/documents/${TOKEN}`, "/api/public/documents/[jeton]"],
    [`/api/public/receipts/${TOKEN}?download=1`, "/api/public/receipts/[jeton]?download=1"],
    [`/api/public/pay/${TOKEN}`, "/api/public/pay/[jeton]"],
    [`/api/public/subscribe/${TOKEN}`, "/api/public/subscribe/[jeton]"],
    [`/api/public/manage/${TOKEN}`, "/api/public/manage/[jeton]"],
    [`/api/public/card/${TOKEN}`, "/api/public/card/[jeton]"],
    [`/api/google/calendar/callback?code=4/0Ab-secret&state=${TOKEN}&scope=x`, "/api/google/calendar/callback?code=[masqué]&state=[masqué]&scope=x"],
    [`/api/public/onboarding?token=${TOKEN}`, "/api/public/onboarding?token=[masqué]"],
    ["/api/clients?search=dupont", "/api/clients?search=dupont"],
  ])("%s", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  it("le journal réel de l'API n'écrit jamais le jeton (chemin ou ?code=)", async () => {
    await app.inject({ method: "GET", url: `/api/public/documents/${TOKEN}`, remoteAddress: "10.6.0.1" });
    await app.inject({ method: "GET", url: `/api/google/calendar/callback?code=4/0Ab-secret&state=${TOKEN}`, remoteAddress: "10.6.0.2" });
    const log = lines.join("");
    expect(log).toContain("/api/public/documents/[jeton]");
    expect(log).toContain("code=[masqué]");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("4/0Ab-secret");
  });
});
