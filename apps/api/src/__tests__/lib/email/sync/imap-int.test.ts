import { describe, expect, it } from "vitest";
import { hasImapFlag, toImapInt, toUidValidity } from "@/lib/email/sync/imap-int.js";

describe("toImapInt", () => {
  it("convertit BigInt en number", () => {
    expect(toImapInt(1787909068n)).toBe(1787909068);
  });

  it("conserve les number", () => {
    expect(toImapInt(42)).toBe(42);
  });

  it("retourne 0 pour null/undefined", () => {
    expect(toImapInt(null)).toBe(0);
    expect(toImapInt(undefined)).toBe(0);
  });
});

describe("toUidValidity", () => {
  it("délègue à toImapInt", () => {
    expect(toUidValidity(99n)).toBe(99);
  });
});

describe("hasImapFlag", () => {
  it("détecte \\Seen quelle que soit la casse", () => {
    expect(hasImapFlag(new Set(["\\Seen"]), "Seen")).toBe(true);
    expect(hasImapFlag(new Set(["\\SEEN"]), "\\Seen")).toBe(true);
    expect(hasImapFlag(["Seen"], "\\Seen")).toBe(true);
    expect(hasImapFlag(new Set(["\\Flagged"]), "Seen")).toBe(false);
    expect(hasImapFlag(undefined, "Seen")).toBe(false);
  });
});
