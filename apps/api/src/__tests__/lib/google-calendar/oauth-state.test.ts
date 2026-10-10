import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOAuthState,
  resolveReturnOrigin,
  verifyOAuthState,
} from "@/lib/google-calendar/oauth-state.js";

const KEYS = ["WEB_ORIGIN", "ADMIN_PUBLIC_ORIGIN", "TAILSCALE_ORIGIN", "SESSION_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.WEB_ORIGIN = "http://192.168.1.52:3000";
  process.env.ADMIN_PUBLIC_ORIGIN = "https://erp.kouzia.test";
  process.env.TAILSCALE_ORIGIN = "http://kouzia.tailnet.ts.net:3000";
  process.env.SESSION_SECRET = "secret-de-test-oauth-state";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("origine de retour", () => {
  it("garde une origine admin de la liste blanche, sinon l'admin LAN", () => {
    expect(resolveReturnOrigin("https://erp.kouzia.test")).toBe("https://erp.kouzia.test");
    expect(resolveReturnOrigin("http://kouzia.tailnet.ts.net:3000/")).toBe("http://kouzia.tailnet.ts.net:3000");
    expect(resolveReturnOrigin("https://evil.example")).toBe("http://192.168.1.52:3000");
    expect(resolveReturnOrigin("https://kouzia.com")).toBe("http://192.168.1.52:3000");
    expect(resolveReturnOrigin(undefined)).toBe("http://192.168.1.52:3000");
  });
});

describe("state signé", () => {
  it("aller-retour", () => {
    expect(verifyOAuthState(createOAuthState("https://erp.kouzia.test"))).toBe("https://erp.kouzia.test");
  });

  it("refuse absent, falsifié, expiré, ou origine retirée de la liste", () => {
    expect(verifyOAuthState(undefined)).toBeNull();
    expect(verifyOAuthState("n'importe.quoi")).toBeNull();

    const state = createOAuthState("https://erp.kouzia.test");
    const [payload, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "https://evil.example", n: "x", e: Date.now() + 60_000 })).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`)).toBeNull();
    expect(verifyOAuthState(`${payload}.${sig}x`)).toBeNull();

    const old = createOAuthState("https://erp.kouzia.test", Date.now() - 11 * 60_000);
    expect(verifyOAuthState(old)).toBeNull();

    delete process.env.ADMIN_PUBLIC_ORIGIN;
    expect(verifyOAuthState(state)).toBeNull();
  });

  it("signature liée à SESSION_SECRET", () => {
    const state = createOAuthState("https://erp.kouzia.test");
    process.env.SESSION_SECRET = "autre-secret";
    expect(verifyOAuthState(state)).toBeNull();
  });
});
