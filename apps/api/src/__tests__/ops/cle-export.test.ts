import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// kouziactl cle-export (demande du 27/10/2026) : console Proxmox du CT seulement, jamais par SSH ni sans terminal ;
// kouziactl status signale des clés jamais exportées ou changées depuis l'export, sans jamais afficher de valeur.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const BASH = process.platform === "win32" && fs.existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const posix = (p: string) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/") : p);

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kouzia-cles-"));
  for (const d of ["ops", "app", "etc", "state"]) fs.mkdirSync(path.join(tmp, d));
  for (const f of ["lib.sh", "cle-export.sh"]) {
    fs.writeFileSync(path.join(tmp, "ops", f), fs.readFileSync(path.join(ROOT, "scripts/alpine", f), "utf8").replace(/\r\n/g, "\n"));
  }
  const key = randomBytes(32).toString("hex");
  const pass = randomBytes(24).toString("base64");
  fs.writeFileSync(path.join(tmp, "app/.env"), `ENCRYPTION_KEY="${key}"\n`);
  fs.writeFileSync(path.join(tmp, "etc/backup-pass"), `${pass}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KOUZIA_APP_DIR: posix(path.join(tmp, "app")),
    KOUZIA_ETC_DIR: posix(path.join(tmp, "etc")),
    KOUZIA_PASSPHRASE_FILE: posix(path.join(tmp, "etc/backup-pass")),
    KOUZIA_STATE_DIR: posix(path.join(tmp, "state")),
    T: posix(tmp),
  };
  return { tmp, key, pass, env };
}

describe("kouziactl cle-export", () => {
  it("refuse par SSH, en renvoyant vers la console Proxmox, sans rien afficher ni noter", () => {
    const { tmp, key, pass, env } = setup();
    const run = spawnSync(BASH, [posix(path.join(tmp, "ops/cle-export.sh"))], {
      env: { ...env, SSH_CONNECTION: "192.0.2.10 50000 192.0.2.20 22" },
      input: "AFFICHER\n\n",
      encoding: "utf8",
    });
    const out = `${run.stdout}${run.stderr}`;
    expect(run.status).not.toBe(0);
    expect(out).toContain("Refusé par SSH");
    expect(out).toContain("console du CT dans Proxmox");
    expect(out).not.toContain(key);
    expect(out).not.toContain(pass);
    expect(fs.existsSync(path.join(tmp, "state/keys-exported-at"))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuse sans terminal interactif (ni root) : aucune valeur affichée", () => {
    const { tmp, key, pass, env } = setup();
    for (const v of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) delete env[v];
    const run = spawnSync(BASH, [posix(path.join(tmp, "ops/cle-export.sh"))], { env, input: "AFFICHER\n\n", encoding: "utf8" });
    const out = `${run.stdout}${run.stderr}`;
    expect(run.status).not.toBe(0);
    expect(out).not.toContain(key);
    expect(out).not.toContain(pass);
    expect(fs.existsSync(path.join(tmp, "state/keys-exported-at"))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("empreinte des clés : stable, change avec la clé ou la phrase, ne contient aucune des deux", () => {
    const { tmp, key, pass, env } = setup();
    const fp = () => spawnSync(BASH, ["-c", 'source "$T/ops/lib.sh"; env_fix_perms() { :; }; keys_fingerprint'], { env, encoding: "utf8" }).stdout.trim();
    const first = fp();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(fp()).toBe(first);
    expect(key).not.toContain(first);
    expect(pass).not.toContain(first);
    fs.writeFileSync(path.join(tmp, "app/.env"), `ENCRYPTION_KEY="${randomBytes(32).toString("hex")}"\n`);
    const afterKey = fp();
    expect(afterKey).not.toBe(first);
    fs.writeFileSync(path.join(tmp, "etc/backup-pass"), `${randomBytes(24).toString("base64")}\n`);
    expect(fp()).not.toBe(afterKey);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
