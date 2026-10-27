import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { hashPassword } from "@/lib/auth.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 : le mot de passe admin de départ quitte le .env une fois l'installation faite.
// Le seed (relancé par une réinstallation) ne doit plus l'exiger quand le compte existe déjà ; il l'exige toujours
// pour créer le compte ou le remplacer (kouziactl configure admin).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const TSX_CLI = createRequire(path.join(ROOT, "package.json")).resolve("tsx/cli");
const EMAIL = "admin-seed@kouzia.test";

function runSeed(extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NODE_ENV: "production", DATABASE_URL: "file:./test.db", ADMIN_EMAIL: EMAIL, ...extra };
  delete env.ADMIN_PASSWORD;
  if (extra.ADMIN_PASSWORD) env.ADMIN_PASSWORD = extra.ADMIN_PASSWORD;
  return spawnSync(process.execPath, [TSX_CLI, "prisma/seed.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
});

describe("seed sans ADMIN_PASSWORD dans le .env", () => {
  it("compte existant : seed réussi, mot de passe inchangé", async () => {
    const hash = await hashPassword("mot-de-passe-existant-123");
    await prisma.user.create({ data: { email: EMAIL, passwordHash: hash } });
    const run = runSeed();
    expect(run.status).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })).passwordHash).toBe(hash);
  }, 150_000);

  it("compte à créer ou à remplacer : mot de passe toujours exigé en production", async () => {
    expect(runSeed().status).not.toBe(0);
    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(0);
    await prisma.user.create({ data: { email: EMAIL, passwordHash: await hashPassword("mot-de-passe-existant-123") } });
    expect(runSeed({ SEED_RESET_ADMIN_PASSWORD: "1" }).status).not.toBe(0);
  }, 150_000);
});
