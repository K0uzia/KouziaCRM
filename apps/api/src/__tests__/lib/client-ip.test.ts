import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isTrustedProxy, parseTrustedProxies } from "@/lib/client-ip.js";

const { buildApp } = await import("@/app.js");

describe("parseTrustedProxies", () => {
  it("true = loopback seulement, false = aucun, défaut selon la production", () => {
    const loop = parseTrustedProxies("true", false);
    expect(isTrustedProxy(loop, "127.0.0.1")).toBe(true);
    expect(isTrustedProxy(loop, "::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedProxy(loop, "::1")).toBe(true);
    expect(isTrustedProxy(loop, "192.168.1.10")).toBe(false);
    expect(parseTrustedProxies("false", true)).toBeNull();
    expect(isTrustedProxy(parseTrustedProxies(undefined, true), "127.0.0.1")).toBe(true);
    expect(parseTrustedProxies(undefined, false)).toBeNull();
  });

  it("liste d'IP et de CIDR (Docker)", () => {
    const list = parseTrustedProxies("172.18.0.0/16, 10.0.0.5", true);
    expect(isTrustedProxy(list, "172.18.3.4")).toBe(true);
    expect(isTrustedProxy(list, "10.0.0.5")).toBe(true);
    expect(isTrustedProxy(list, "127.0.0.1")).toBe(false);
    expect(() => parseTrustedProxies("pas-une-ip", true)).toThrow(/TRUST_PROXY/);
  });
});

describe("request.ip derrière le tunnel", () => {
  let app: FastifyInstance | undefined;
  const previous = process.env.TRUST_PROXY;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
    delete process.env.ADMIN_PUBLIC_ORIGIN;
  });

  async function appWith(trust: string) {
    process.env.TRUST_PROXY = trust;
    process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.kouzia.test";
    app = await buildApp({ silent: true, serveStatic: false });
    app.get("/__ip", async (request) => ({ ip: request.ip }));
    return app;
  }

  it("depuis cloudflared (loopback) : CF-Connecting-IP fait foi, X-Forwarded-For du client ignoré", async () => {
    const a = await appWith("true");
    const res = await a.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: "127.0.0.1",
      headers: { host: "erp.kouzia.test", "cf-connecting-ip": "198.51.100.23", "x-forwarded-for": "203.0.113.7, 198.51.100.23" },
    });
    expect(res.json()).toEqual({ ip: "198.51.100.23" });
  });

  it("client direct (LAN) : X-Forwarded-For et CF-Connecting-IP ignorés", async () => {
    const a = await appWith("true");
    const res = await a.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: "192.168.1.50",
      headers: { host: "erp.kouzia.test", "cf-connecting-ip": "198.51.100.23", "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.json()).toEqual({ ip: "192.168.1.50" });
  });

  it("un X-Forwarded-For inventé ne crée pas de nouveau compteur de limite de débit", async () => {
    const a = await appWith("true");
    const remaining: string[] = [];
    for (const xff of ["203.0.113.7", "198.51.100.9", "192.0.2.1"]) {
      const res = await a.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "127.0.0.1",
        headers: { host: "erp.kouzia.test", "cf-connecting-ip": "198.51.100.23", "x-forwarded-for": xff },
        payload: {},
      });
      remaining.push(String(res.headers["x-ratelimit-remaining"]));
    }
    expect(remaining).toEqual(["9", "8", "7"]);
  });
});
