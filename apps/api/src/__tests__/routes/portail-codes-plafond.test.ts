import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { CODE_MAX_PER_DAY, issuePortalCode, VERIFY_FAILURE_FLOOR_MS } from "@/lib/portal/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// P2 de l'audit du 27/10/2026 (décision 12) : codes de l'espace client sans plafond journalier (5 codes par heure, donc
// 600 essais par jour), et refus de /api/public/auth/verify plus rapide pour une adresse inconnue (énumération).
const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function portalClient(email: string) {
  const c = await createClient({ displayName: "Client Portail" });
  return prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(email), emailHash: computeEmailHash(email) } });
}

describe("codes de l'espace client", () => {
  it("plafond journalier : au-delà de CODE_MAX_PER_DAY codes en 24 h, plus de code, même après l'heure", async () => {
    const client = await portalClient("lea@exemple.fr");
    const now = Date.now();
    await prisma.portalCode.createMany({
      data: Array.from({ length: CODE_MAX_PER_DAY }, (_, i) => ({
        clientId: client.id,
        purpose: "LOGIN",
        codeHash: "0".repeat(64),
        createdAt: new Date(now - (2 + i) * 3_600_000),
        expiresAt: new Date(now - (2 + i) * 3_600_000 + 900_000),
      })),
    });
    expect(await issuePortalCode(client.id, "LOGIN")).toBeNull();
  });

  it("refus de vérification : jamais plus rapide que le plancher, adresse connue ou non", async () => {
    await portalClient("connue@exemple.fr");
    for (const email of ["inconnue@exemple.fr", "connue@exemple.fr"]) {
      const started = Date.now();
      const res = await app.inject({ method: "POST", url: "/api/public/auth/verify", remoteAddress: "203.0.113.50", payload: { email, code: "123456" } });
      const elapsed = Date.now() - started;
      expect(res.statusCode).toBe(401);
      expect(elapsed, email).toBeGreaterThanOrEqual(VERIFY_FAILURE_FLOOR_MS - 5);
    }
  });
});
