import { describe, expect, it } from "vitest";
import { isValidSiren, isValidSiret, luhnCheck } from "./luhn.js";
import { parseSirenOrSiret, sirenSiretErrorMessage } from "./siren-siret.js";

describe("luhnCheck", () => {
  it("accepte un SIREN connu valide", () => {
    // Google France
    expect(isValidSiren("732829320")).toBe(true);
  });

  it("rejette un SIREN avec mauvaise clé", () => {
    expect(isValidSiren("732829321")).toBe(false);
  });

  it("accepte un SIRET connu valide", () => {
    expect(isValidSiret("73282932000074")).toBe(true);
  });

  it("rejette un SIRET invalide", () => {
    expect(isValidSiret("73282932000075")).toBe(false);
  });

  it("rejette les chaînes non numériques", () => {
    expect(luhnCheck("abc")).toBe(false);
    expect(isValidSiren("")).toBe(false);
  });
});

describe("parseSirenOrSiret", () => {
  it("parse un SIREN", () => {
    const r = parseSirenOrSiret("732 829 320");
    expect(r.kind).toBe("siren");
    expect(r.siren).toBe("732829320");
  });

  it("parse un SIRET et dérive le SIREN", () => {
    const r = parseSirenOrSiret("73282932000074");
    expect(r.kind).toBe("siret");
    expect(r.siren).toBe("732829320");
    expect(r.siret).toBe("73282932000074");
  });

  it("signale invalide", () => {
    expect(parseSirenOrSiret("123").kind).toBe("invalid");
    expect(sirenSiretErrorMessage("123")).toMatch(/incomplet/i);
  });
});
