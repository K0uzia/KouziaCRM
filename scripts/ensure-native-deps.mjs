#!/usr/bin/env node
/**
 * Vérifie que le binaire natif lightningcss est installé pour la plateforme courante.
 * npm omet parfois les optionalDependencies (workspaces, cache, copie cross-OS).
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

function lightningcssPlatformPackage() {
  const parts = [process.platform, process.arch];
  if (process.platform === "linux") {
    try {
      const { MUSL, familySync } = require("detect-libc");
      const family = familySync();
      if (family === MUSL) {
        parts.push("musl");
      } else if (process.arch === "arm") {
        parts.push("gnueabihf");
      } else {
        parts.push("gnu");
      }
    } catch {
      parts.push("gnu");
    }
  } else if (process.platform === "win32") {
    parts.push("msvc");
  }
  return `lightningcss-${parts.join("-")}`;
}

function ensureLightningcss() {
  const pkg = lightningcssPlatformPackage();
  if (existsSync(join(root, "node_modules", pkg))) {
    return;
  }

  console.log(`Binaire natif lightningcss manquant, installation de ${pkg}…`);
  execSync(`npm install --no-save ${pkg}@1.32.0`, {
    cwd: root,
    stdio: "inherit",
  });

  if (!existsSync(join(root, "node_modules", pkg))) {
    console.error(`Échec : ${pkg} introuvable après installation.`);
    process.exit(1);
  }

  console.log("lightningcss OK");
}

ensureLightningcss();
