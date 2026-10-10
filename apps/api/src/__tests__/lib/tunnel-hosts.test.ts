import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isPublicRoute } from "@/lib/tunnel-hosts.js";

const saved = { trust: process.env.TRUST_PROXY, admin: process.env.ADMIN_PUBLIC_ORIGIN };
process.env.TRUST_PROXY = "true";
process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.kouzia.test";
const { buildApp } = await import("@/app.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});

afterAll(async () => {
  await app.close();
  if (saved.trust === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = saved.trust;
  if (saved.admin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN;
  else process.env.ADMIN_PUBLIC_ORIGIN = saved.admin;
});

let n = 1;
const viaTunnel = (host: string, extra: Record<string, string> = {}) => ({
  remoteAddress: "127.0.0.1",
  headers: { host, "cf-connecting-ip": `203.0.113.${n++ % 250}`, ...extra },
});

describe("isPublicRoute", () => {
  it("routes publiques seulement, d'après le motif du routeur", () => {
    expect(isPublicRoute("/api/public/tracking")).toBe(true);
    expect(isPublicRoute("/api/webhooks/revolut")).toBe(true);
    expect(isPublicRoute("/api/google/calendar/callback")).toBe(true);
    expect(isPublicRoute("/api/health")).toBe(true);
    expect(isPublicRoute("/api/auth/login")).toBe(false);
    expect(isPublicRoute("/api/publicity")).toBe(false);
    expect(isPublicRoute(undefined)).toBe(false);
  });
});

describe("garde d'hôte du tunnel", () => {
  it("api. : routes publiques servies, admin en 404 identique", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health", ...viaTunnel("api.kouzia.test") });
    expect(health.statusCode).toBe(200);
    const tracking = await app.inject({ method: "GET", url: "/api/public/tracking", ...viaTunnel("api.kouzia.test") });
    expect(tracking.statusCode).toBe(401);

    const unknown = await app.inject({ method: "GET", url: "/api/nexiste-pas", ...viaTunnel("erp.kouzia.test") });
    for (const url of ["/api/auth/me", "/api/clients", "/api/settings"]) {
      const res = await app.inject({ method: "GET", url, ...viaTunnel("api.kouzia.test") });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
    }
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@b.fr", password: "x" },
      ...viaTunnel("api.kouzia.test"),
    });
    expect(login.statusCode).toBe(404);
  });

  it("hôte inconnu ou absent par le tunnel : traité comme api.", async () => {
    for (const host of ["autre.kouzia.test", "erp.kouzia.test.evil.example", ""]) {
      const res = await app.inject({ method: "GET", url: "/api/auth/me", ...viaTunnel(host) });
      expect(res.statusCode).toBe(404);
    }
  });

  it("X-Forwarded-Host ne permet pas de se faire passer pour erp.", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      ...viaTunnel("api.kouzia.test", { "x-forwarded-host": "erp.kouzia.test" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("erp. : API admin servie", async () => {
    const me = await app.inject({ method: "GET", url: "/api/auth/me", ...viaTunnel("erp.kouzia.test") });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: null });
  });

  it("LAN et Tailscale : aucun filtrage, quel que soit l'hôte", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      remoteAddress: "192.168.1.20",
      headers: { host: "api.kouzia.test" },
    });
    expect(res.statusCode).toBe(200);
  });
});
