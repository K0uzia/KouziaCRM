import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { consumeRecoveryCode, regenerateRecoveryCodes, remainingRecoveryCodes } from "@/lib/admin/two-factor.js";
import { hashPassword } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";

// Défauts du 27/10/2026 : (1) une ENCRYPTION_KEY de 64 caractères non hexadécimaux était acceptée par le chiffrement
// (Buffer.from(…, "hex") s'arrête au premier caractère invalide : clé plus faible, sans erreur) ; (2) les codes de
// secours 2FA étaient hachés avec la clé de chiffrement elle-même, sans sous-clé dédiée.
const KEY = process.env.ENCRYPTION_KEY!;
afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

describe("clé de chiffrement : hexadécimal strict", () => {
  it.each([
    ["caractère non hexadécimal", `zz${KEY.slice(2)}`],
    ["espace copiée au milieu", `${KEY.slice(0, 31)} ${KEY.slice(32)}`],
    ["63 caractères", KEY.slice(1)],
  ])("refusée avec un message clair : %s", (_label, key) => {
    process.env.ENCRYPTION_KEY = key;
    expect(() => encrypt("donnée")).toThrow(/ENCRYPTION_KEY.*64 caractères hexadécimaux/);
    expect(() => computeEmailHash("lou@example.test")).toThrow(/ENCRYPTION_KEY.*64 caractères hexadécimaux/);
  });

  it("clé valide (majuscules comprises) : chiffrement inchangé", () => {
    process.env.ENCRYPTION_KEY = KEY.toUpperCase();
    expect(decrypt(encrypt("donnée"))).toBe("donnée");
  });
});

describe("codes de secours 2FA : sous-clé dédiée, anciens codes toujours valables", () => {
  let userId: string;
  beforeEach(async () => {
    await resetDb();
    await prisma.user.deleteMany({ where: { email: "admin-secours@kouzia.test" } });
    userId = (await prisma.user.create({ data: { email: "admin-secours@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") } })).id;
  });
  afterAll(async () => {
    await resetDb();
  });

  const legacyHash = (code: string) =>
    createHmac("sha256", Buffer.from(KEY, "hex")).update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

  it("nouveaux codes : hachés avec la sous-clé, jamais avec la clé de chiffrement elle-même", async () => {
    const [code] = await regenerateRecoveryCodes(userId);
    const row = await prisma.adminRecoveryCode.findFirstOrThrow({ where: { userId } });
    expect(row.codeHash).not.toBe(legacyHash(code!));
    expect(await consumeRecoveryCode(userId, code!)).toBe(true);
    expect(await consumeRecoveryCode(userId, code!)).toBe(false);
  });

  it("code d'avant le changement (haché avec la clé) : accepté une fois, puis refusé", async () => {
    const code = "ABCDE-FGHJK";
    await prisma.adminRecoveryCode.create({ data: { userId, codeHash: legacyHash(code) } });
    expect(await remainingRecoveryCodes(userId)).toBe(1);
    expect(await consumeRecoveryCode(userId, "abcde fghjk")).toBe(true);
    expect(await consumeRecoveryCode(userId, code)).toBe(false);
    expect(await remainingRecoveryCodes(userId)).toBe(0);
  });

  it("code inconnu : refusé", async () => {
    await regenerateRecoveryCodes(userId);
    expect(await consumeRecoveryCode(userId, "ZZZZZ-ZZZZZ")).toBe(false);
  });
});
