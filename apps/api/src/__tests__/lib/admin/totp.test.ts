import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotpStep,
  otpauthUri,
  totpStep,
} from "@/lib/admin/totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("HOTP (RFC 4226, annexe D)", () => {
  it("vecteurs officiels, 6 chiffres", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });
});

describe("TOTP (RFC 6238, annexe B, SHA1)", () => {
  it("vecteurs officiels, 8 chiffres", () => {
    const cases: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of cases) expect(hotp(RFC_SECRET, totpStep(t * 1000), 8)).toBe(code);
  });

  it("fenêtre ±1 pas, refus au-delà, pas renvoyé pour l'anti-rejeu", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1111111111 * 1000;
    const step = totpStep(now);
    const codeAt = (s: number) => hotp(RFC_SECRET, s);
    expect(matchTotpStep(secret, codeAt(step), now)).toBe(step);
    expect(matchTotpStep(secret, codeAt(step - 1), now)).toBe(step - 1);
    expect(matchTotpStep(secret, codeAt(step + 1), now)).toBe(step + 1);
    expect(matchTotpStep(secret, codeAt(step - 2), now)).toBeNull();
    expect(matchTotpStep(secret, codeAt(step + 2), now)).toBeNull();
    expect(matchTotpStep(secret, "12345", now)).toBeNull();
    expect(matchTotpStep(secret, "abcdef", now)).toBeNull();
  });
});

describe("base32 et secret", () => {
  it("aller-retour et clé lisible (espaces et minuscules tolérés)", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(base32Encode(base32Decode(secret.toLowerCase().replace(/(.{4})/g, "$1 ")))).toBe(secret);
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("URI otpauth pour Google Authenticator", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "admin@kouzia.com", "Kouzia ERP");
    expect(uri).toBe(
      "otpauth://totp/Kouzia%20ERP%3Aadmin%40kouzia.com?secret=JBSWY3DPEHPK3PXP&issuer=Kouzia+ERP&algorithm=SHA1&digits=6&period=30",
    );
  });
});
