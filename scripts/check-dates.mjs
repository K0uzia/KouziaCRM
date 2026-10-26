// Contrôle du build web : aucune date du jour tirée de toISOString (jour UTC, la veille entre minuit et 1 ou 2 h à Paris).
// Le jour local s'écrit toIsoDate(new Date()) (components/ui/DatePicker). Échoue sur toute occurrence dans apps/web/src.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../apps/web/src");
const pattern = /toISOString\(\)\s*\.\s*(slice|substring)\(\s*0\s*,\s*10\s*\)|toISOString\(\)\s*\.\s*split\(\s*["'`]T["'`]\s*\)/;
const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(name)) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (pattern.test(line)) found.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
walk(root);
if (found.length) {
  console.error("Date du jour en UTC (toISOString) : utiliser toIsoDate(new Date()) de components/ui/DatePicker.\n" + found.join("\n"));
  process.exit(1);
}
console.log("check:dates : aucune date du jour en UTC dans apps/web.");
