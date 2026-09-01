import { describe, expect, it } from "vitest";
import { computeEmailHash } from "@/lib/clients/email-hash.js";

describe("computeEmailHash", () => {
  it("normalise et produit un hash stable", () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    const h1 = computeEmailHash(" Client@Example.COM ");
    const h2 = computeEmailHash("client@example.com");
    expect(h1).toBeTruthy();
    expect(h1).toBe(h2);
  });

  it("retourne null si email vide", () => {
    expect(computeEmailHash("")).toBeNull();
    expect(computeEmailHash(null)).toBeNull();
  });
});
