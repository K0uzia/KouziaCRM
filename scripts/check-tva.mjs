// Contrôle du build web : aucune mention de TVA en dur dans le code (charte : le contenu légal vient des réglages).
// La mention imprimée est le réglage vatMention (Réglages > Mentions légales). Échoue sur l'ancienne référence
// « art. 293 B » écrite dans apps/api/src, apps/web/src ou packages, tests exceptés ; le code interne
// FRANCHISE_BASE_293B (sans espace, jamais imprimé) n'est pas visé. Ligne permise : marquée « check:tva autorisé ».
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const roots = ["apps/api/src", "apps/web/src", "packages"].map((r) => path.join(repo, r));
const pattern = /293\s+B\b|art\.?\s*293/i;
const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (pattern.test(line) && !line.includes("check:tva autorisé")) found.push(`${path.relative(repo, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
for (const root of roots) walk(root);
if (found.length) {
  console.error("Mention de TVA en dur : lire le réglage vatMention (ou la variable {{mention_tva}} d'une clause).\n" + found.join("\n"));
  process.exit(1);
}
console.log("check:tva : aucune mention de TVA en dur dans le code.");
