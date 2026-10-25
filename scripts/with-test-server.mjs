#!/usr/bin/env node
/**
 * Serveur d'API de test le temps d'une commande (recette, check:mobile, check:desktop), depuis la racine d'un checkout :
 *   node scripts/with-test-server.mjs -- npm run check:mobile
 * Variables : .env de ce checkout (--env-file), NODE_ENV=production, relevé de la mémoire toutes les 10 s.
 * Dette du serveur de test (26/10/2026) : un serveur arrêté pendant le contrôle était muet. Ici :
 * - le serveur est un processus enfant direct (node, pas npx) : son PID est connu, il est arrêté sans rien deviner ;
 * - journal propre à chaque passage (dossier temporaire, chemin affiché), jamais écrasé par le suivant ;
 * - arrêt pendant le contrôle : code de sortie, signal, dernières lignes (dont la ligne d'arrêt et la mémoire écrites par
 *   l'API, lib/process-diagnostics.ts), et la commande échoue (code 1) même si elle a réussi.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sep = process.argv.indexOf("--");
const command = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (!command.length) {
  console.error("Usage : node scripts/with-test-server.mjs -- <commande>");
  process.exit(2);
}

const root = process.cwd();
const env = Object.fromEntries(
  readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?(.*?)"?\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const port = env.API_PORT || "3001";
const base = `http://localhost:${port}`;
const health = () => fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

if (await health()) {
  console.error(`Port ${port} déjà occupé : rien n'est lancé (arrêtez d'abord le serveur qui l'utilise).`);
  process.exit(1);
}

const dir = path.join(os.tmpdir(), "kouzia-test-server");
mkdirSync(dir, { recursive: true });
const logPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(root)}.log`);
const log = createWriteStream(logPath);
const tail = [];
const keep = (chunk) => {
  log.write(chunk);
  for (const line of String(chunk).split("\n").filter(Boolean)) {
    tail.push(line);
    if (tail.length > 30) tail.shift();
  }
};

const server = spawn(process.execPath, ["--env-file=.env", "--import", "tsx", "apps/api/src/index.ts"], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "production", TSX_TSCONFIG_PATH: "apps/api/tsconfig.json", KOUZIA_MEMORY_LOG_MS: "10000" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", keep);
server.stderr.on("data", keep);
let serverExit = null;
const exited = new Promise((resolve) =>
  server.on("exit", (code, signal) => {
    serverExit = { code, signal };
    resolve(serverExit);
  }),
);
console.log(`serveur de test : PID ${server.pid}, journal ${logPath}`);

const report = (title) => {
  // Windows : un arrêt forcé rend 4294967295 (soit -1 en entier signé).
  const c = serverExit?.code;
  const shown = c == null ? "inconnu" : c > 0x7fffffff ? `${c - 0x100000000} (arrêt forcé)` : String(c);
  console.error(`\n${title} : code ${shown}, signal ${serverExit?.signal ?? "aucun"}. Journal : ${logPath}`);
  console.error(tail.slice(-15).join("\n"));
};

for (let i = 0; i < 60 && !serverExit && !(await health()); i++) await new Promise((r) => setTimeout(r, 1000));
if (serverExit || !(await health())) {
  report("Serveur de test non démarré");
  server.kill();
  process.exit(1);
}

// Une seule chaîne : avec shell, Node 24 refuse la liste d'arguments séparée (DEP0190).
const run = spawn(command.join(" "), { cwd: root, stdio: "inherit", shell: true });
const runExit = new Promise((resolve) => run.on("exit", (code) => resolve(code ?? 1)));
const first = await Promise.race([runExit.then((code) => ({ code })), exited.then(() => ({ died: true }))]);

let code;
if (first.died) {
  report("Serveur de test arrêté PENDANT le contrôle");
  code = 1;
  await runExit;
} else {
  code = first.code;
  if (serverExit) {
    report("Serveur de test arrêté pendant le contrôle");
    code = 1;
  } else {
    server.kill("SIGTERM");
    const stopped = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
    if (!stopped) server.kill("SIGKILL");
    console.log(`serveur de test ${server.pid} arrêté`);
  }
}
log.end();
process.exit(code);
