import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/auth.js";
import { clearFailures, LOCK_AFTER_FAILURES, registerFailure } from "@/lib/admin/two-factor.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// P2 de l'audit du 27/10/2026 (décision 12) : verrouillage admin par le tunnel toujours de 15 min, sans allongement ni
// alerte. Désormais : 15 min, puis 30, 60… (24 h au plus) tant qu'aucune connexion ne réussit, et un e-mail au titulaire.
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: async () => true }));

const EMAIL = "admin-verrou@kouzia.test";
const tunnel = { viaTunnel: true, ip: "198.51.100.7", headers: { "user-agent": "Mozilla/5.0 Test" } } as unknown as FastifyRequest;
const MIN = 60_000;

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.user.create({ data: { email: EMAIL, passwordHash: await hashPassword("mot-de-passe-de-test") } });
});

async function failBlock(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { lockedUntil: null } });
  const started = Date.now();
  for (let i = 0; i < LOCK_AFTER_FAILURES; i++) await registerFailure(userId, tunnel);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return Math.round((user.lockedUntil!.getTime() - started) / MIN);
}

describe("verrouillage admin progressif par le tunnel", () => {
  it("15 min, puis 30, puis 60 ; remis à zéro par une connexion réussie ; e-mail à chaque verrouillage", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(await failBlock(user.id)).toBe(15);
    expect(await failBlock(user.id)).toBe(30);
    expect(await failBlock(user.id)).toBe(60);
    expect(await prisma.emailOutbox.count()).toBe(3);
    await clearFailures(user.id);
    expect(await failBlock(user.id)).toBe(15);
  });

  it("plafond de 24 h", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    let last = 0;
    for (let i = 0; i < 9; i++) last = await failBlock(user.id);
    expect(last).toBe(24 * 60);
  });
});
