import { afterEach, describe, expect, it } from "vitest";
import { getAllowedOrigins } from "@/lib/env.js";

const KEYS = ["WEB_ORIGIN", "AUTH_URL", "PUBLIC_WEB_ORIGIN", "TAILSCALE_ORIGIN"] as const;

const snapshot: Record<string, string | undefined> = {};

function rememberEnv() {
  for (const k of KEYS) snapshot[k] = process.env[k];
}

function restoreEnv() {
  for (const k of KEYS) {
    const v = snapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("getAllowedOrigins", () => {
  rememberEnv();
  afterEach(restoreEnv);

  it("inclut WEB_ORIGIN, PUBLIC_WEB_ORIGIN et TAILSCALE_ORIGIN", () => {
    process.env.WEB_ORIGIN = "http://192.168.1.50:3000";
    process.env.PUBLIC_WEB_ORIGIN = "https://kouzia.com";
    process.env.TAILSCALE_ORIGIN = "http://kouzia.tailnet-abc.ts.net:3000";
    const origins = getAllowedOrigins();
    expect(origins).toEqual(
      expect.arrayContaining([
        "http://192.168.1.50:3000",
        "https://kouzia.com",
        "http://kouzia.tailnet-abc.ts.net:3000",
      ]),
    );
  });

  it("ignore TAILSCALE_ORIGIN vide", () => {
    process.env.WEB_ORIGIN = "http://192.168.1.50:3000";
    process.env.PUBLIC_WEB_ORIGIN = "";
    process.env.TAILSCALE_ORIGIN = "  ";
    const origins = getAllowedOrigins();
    expect(origins).toEqual(["http://192.168.1.50:3000"]);
  });
});
