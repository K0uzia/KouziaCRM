// kouziactl audit report : rapport en lecture seule, sans donnée personnelle ni secret (voir audit-lib.mjs).
// Usage : node --disable-warning=ExperimentalWarning scripts/alpine/audit-report.mjs [--json|--text]
//         [--app-dir <dossier>] [--db <fichier>] [--log-dir <dossier>] [--lines <n>]
// Base par défaut : KOUZIA_DB_PATH, sinon DATABASE_URL du .env (relatif à prisma/), sinon data/kouziacrm.db.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, renderText } from "./audit-lib.mjs";

function parseArgs(argv) {
  const o = { format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Valeur manquante après ${a}`);
      return v;
    };
    if (a === "--json") o.format = "json";
    else if (a === "--text") o.format = "text";
    else if (a === "--app-dir") o.appDir = next();
    else if (a === "--db") o.dbPath = next();
    else if (a === "--log-dir") o.logDir = next();
    else if (a === "--lines") o.lines = Number(next());
    else throw new Error(`Option inconnue : ${a}`);
  }
  return o;
}

// Chemin de la base seulement : la ligne DATABASE_URL est lue, aucune autre valeur du .env.
function dbFromEnv(appDir) {
  try {
    const line = fs.readFileSync(path.join(appDir, ".env"), "utf8").split(/\r?\n/).filter((l) => /^\s*DATABASE_URL\s*=/.test(l)).at(-1);
    const m = line && /=\s*["']?file:([^"'\s?]+)/.exec(line);
    if (!m) return null;
    return path.isAbsolute(m[1]) ? m[1] : path.resolve(appDir, "prisma", m[1]);
  } catch {
    return null;
  }
}

try {
  const o = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(o.appDir ?? process.env.KOUZIA_APP_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const dbPath = o.dbPath ?? process.env.KOUZIA_DB_PATH ?? dbFromEnv(appDir) ?? path.join(appDir, "data", "kouziacrm.db");
  const logDir = o.logDir ?? process.env.KOUZIA_LOG_DIR ?? (fs.existsSync("/var/log/kouzia") ? "/var/log/kouzia" : null);
  const report = buildReport({ dbPath, appDir, logDir, lines: o.lines ?? 30 });
  process.stdout.write(o.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
} catch (err) {
  // Message seul (jamais de pile ni de valeur lue) : chemin ou option en cause.
  process.stderr.write(`ERREUR audit : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
