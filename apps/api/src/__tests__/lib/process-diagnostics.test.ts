import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Arrêt du processus tracé (dette du serveur de test) : un vrai processus Node, qui sort avec un code ou sur une exception.
const MODULE = pathToFileURL(path.resolve(__dirname, "../../lib/process-diagnostics.ts")).href;

function run(body: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kouzia-diag-"));
  const file = path.join(dir, "child.ts");
  writeFileSync(file, `import { installExitDiagnostics } from ${JSON.stringify(MODULE)};\nconst d = installExitDiagnostics();\n${body}\n`);
  const r = spawnSync(process.execPath, ["--import", "tsx", file], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
  const lines = r.stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: r.status, lines };
}

describe("trace d'arrêt du processus", () => {
  it("code de sortie, dernier signal et mémoire", () => {
    const { status, lines } = run(`d.noteSignal("SIGTERM");\nprocess.exit(3);`);
    expect(status).toBe(3);
    const last = lines.at(-1)!;
    expect(last).toMatchObject({ code: 3, signal: "SIGTERM", msg: "[processus] arrêt, code 3 après SIGTERM", level: 50 });
    expect(typeof last.rssMo).toBe("number");
    expect(typeof last.heapUsedMo).toBe("number");
  }, 30_000);

  it("exception non gérée : journalisée avec la mémoire, puis arrêt en code 1", () => {
    const { status, lines } = run(`setTimeout(() => { throw new Error("panne de test"); }, 10);`);
    expect(status).toBe(1);
    expect(lines[0]).toMatchObject({ msg: "[processus] exception non gérée : arrêt", origin: "uncaughtException" });
    expect(String(lines[0]!.err)).toContain("panne de test");
    expect(lines.at(-1)).toMatchObject({ code: 1, signal: null });
  }, 30_000);

  it("relevé périodique de la mémoire si KOUZIA_MEMORY_LOG_MS est fixé", () => {
    const { lines } = run(`setTimeout(() => process.exit(0), 2300);`, { KOUZIA_MEMORY_LOG_MS: "1000" });
    expect(lines.filter((l) => l.msg === "[processus] mémoire").length).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)).toMatchObject({ code: 0, level: 30 });
  }, 30_000);
});
