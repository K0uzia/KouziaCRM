#!/usr/bin/env node
/**
 * Vérifie que le binaire natif lightningcss est installé pour la plateforme courante.
 * npm omet parfois les optionalDependencies (workspaces, cache, copie cross-OS).
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

function isMusl() {
  if (existsSync("/etc/alpine-release")) {
    return true;
  }
  try {
    const { MUSL, familySync } = require("detect-libc");
    return familySync() === MUSL;
  } catch {
    return false;
  }
}

function lightningcssPlatformPackage() {
  const parts = [process.platform, process.arch];
  if (process.platform === "linux") {
    if (isMusl()) {
      parts.push("musl");
    } else if (process.arch === "arm") {
      parts.push("gnueabihf");
    } else {
      parts.push("gnu");
    }
  } else if (process.platform === "win32") {
    parts.push("msvc");
  }
  return `lightningcss-${parts.join("-")}`;
}

function pkgVersion(name) {
  const pkgPath = join(root, "node_modules", name, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }
  return JSON.parse(readFileSync(pkgPath, "utf8")).version;
}

function removeNativePkg(pkg) {
  const dest = join(root, "node_modules", pkg);
  if (!existsSync(dest)) {
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  console.log(`Retiré ${pkg} (binaire glibc incompatible musl).`);
}

function ensureNativePkg(pkg, version) {
  if (!version) {
    return;
  }
  if (existsSync(join(root, "node_modules", pkg))) {
    return;
  }
  console.log(`Binaire natif manquant, installation de ${pkg}@${version}…`);
  execSync(`npm install --no-save ${pkg}@${version}`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, npm_config_libc: isMusl() ? "musl" : process.env.npm_config_libc },
  });
}

function ensureViteNatives() {
  // Runtime Docker (vite absent) : pas de build SPA, binaires Vite inutiles.
  // Le CT Alpine build la SPA même avec NODE_ENV=production.
  const viteRoot = join(root, "node_modules", "vite");
  const viteWeb = join(root, "apps", "web", "node_modules", "vite");
  if (!existsSync(viteRoot) && !existsSync(viteWeb)) {
    return;
  }

  if (isMusl() && process.arch === "x64") {
    removeNativePkg("@rollup/rollup-linux-x64-gnu");
    removeNativePkg("lightningcss-linux-x64-gnu");
    removeNativePkg("@tailwindcss/oxide-linux-x64-gnu");
    ensureNativePkg("@rollup/rollup-linux-x64-musl", pkgVersion("rollup") || "4.62.5");
    ensureNativePkg("lightningcss-linux-x64-musl", pkgVersion("lightningcss") || "1.32.0");
    ensureNativePkg(
      "@tailwindcss/oxide-linux-x64-musl",
      pkgVersion("@tailwindcss/oxide") || pkgVersion("tailwindcss") || "4.3.3",
    );
    return;
  }

  const pkg = lightningcssPlatformPackage();
  ensureNativePkg(pkg, pkgVersion("lightningcss") || "1.32.0");
  if (!existsSync(join(root, "node_modules", pkg))) {
    console.error(`Échec : ${pkg} introuvable après installation.`);
    process.exit(1);
  }
}

function patchReactPdfHyphenate() {
  const pkgPath = join(root, "node_modules", "@react-pdf", "hyphenate", "package.json");
  if (!existsSync(pkgPath)) {
    return;
  }

  const json = JSON.parse(readFileSync(pkgPath, "utf8"));
  let changed = false;

  for (const key of [".", "./*"]) {
    const entry = json.exports?.[key];
    if (entry && !entry.require && entry.import) {
      entry.require = entry.import;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
    console.log("@react-pdf/hyphenate exports patch OK");
  }
}

ensureViteNatives();
patchReactPdfHyphenate();
