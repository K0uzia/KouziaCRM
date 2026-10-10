import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diffPending, listMigrationNames } from "@/lib/migration-check.js";

const dir = mkdtempSync(path.join(tmpdir(), "kz-migrations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("contrôle des migrations au démarrage", () => {
  it("liste les dossiers qui ont un migration.sql, triés", () => {
    for (const name of ["20261010130000_b", "20261009120000_a"]) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "migration.sql"), "SELECT 1;");
    }
    mkdirSync(path.join(dir, "brouillon_sans_sql"));
    writeFileSync(path.join(dir, "migration_lock.toml"), "provider = \"sqlite\"");
    expect(listMigrationNames(dir)).toEqual(["20261009120000_a", "20261010130000_b"]);
  });

  it("signale ce qui n'est pas appliqué (cas du 500 en dev : nouvelle colonne non migrée)", () => {
    expect(diffPending(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(diffPending(["a", "b", "c"], ["a", "b"])).toEqual(["c"]);
    expect(diffPending(["a", "b"], ["a", "b", "ancienne_supprimee"])).toEqual([]);
  });

  it("le dépôt contient bien ses migrations (chemin résolu depuis le code)", () => {
    const names = listMigrationNames();
    expect(names.length).toBeGreaterThan(40);
    expect(names).toContain("20261010100000_portal_email_auth");
  });
});
