import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Règle web-design : pas de bordure gauche d'accent sur une carte ou un encadré, PDF compris (devis, factures,
// avoirs, reçus, livre de recettes). Le contrôle lit les sources de tous les documents PDF.
const PDF_DIR = path.resolve(import.meta.dirname, "../../../lib/pdf");

describe("PDF : aucune bordure gauche d'accent", () => {
  it("aucun borderLeft* dans les composants et styles PDF", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(PDF_DIR).filter((f) => /\.(tsx?|ts)$/.test(f))) {
      fs.readFileSync(path.join(PDF_DIR, file), "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/borderLeft/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
