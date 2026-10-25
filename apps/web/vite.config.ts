import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envDir = path.resolve(__dirname, "../..");

/**
 * Origine du hors ligne (ADMIN_PUBLIC_ORIGIN) écrite au build dans index.html. En production, l'API la réécrit
 * à chaque service de la page avec sa propre configuration : c'est la valeur d'exécution qui fait foi.
 */
function offlineOrigin(mode: string): Plugin {
  const value = process.env.ADMIN_PUBLIC_ORIGIN ?? loadEnv(mode, envDir, "").ADMIN_PUBLIC_ORIGIN ?? "";
  const safe = value.replace(/[^A-Za-z0-9:/._-]/g, "");
  return {
    name: "kouzia-offline-origin",
    transformIndexHtml: (html) => html.replace(/(<meta name="kouzia-offline-origin" content=")[^"]*(")/, `$1${safe}$2`),
  };
}

/**
 * Identifiant de ce build : balise kouzia-build d'index.html et dist/version.json, que l'API lit au démarrage et renvoie
 * dans X-Kouzia-Build. Un écart signale une interface plus ancienne que le serveur. Jamais compilé dans un module : il
 * changerait l'empreinte de presque tous les fichiers à chaque build, retéléchargés à chaque mise à jour (mesuré : 49 sur 70).
 */
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function buildVersion(): Plugin {
  return {
    name: "kouzia-build-version",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
    },
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: "kouzia-build", content: BUILD_ID }, injectTo: "head" }];
    },
  };
}

/**
 * Modules de l'application chargés au démarrage (imports statiques depuis src/main.tsx), sauf l'entrée, le routeur et la
 * mise en page (ils importent les pages à la demande : leur empreinte suit chaque page) et les écrans chargés d'office.
 */
let shell: Set<string> | null = null;
type ModuleInfoOf = (id: string) => { importedIds: readonly string[] } | null;
function shellModules(getModuleInfo: ModuleInfoOf): Set<string> {
  if (shell) return shell;
  const slash = (p: string) => p.split(String.fromCharCode(92)).join("/");
  const entry = slash(path.resolve(__dirname, "src/main.tsx"));
  const keep = new Set([entry, slash(path.resolve(__dirname, "src/App.tsx")), slash(path.resolve(__dirname, "src/components/AppLayout.tsx"))]);
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of getModuleInfo(id)?.importedIds ?? []) if (!slash(next).includes("/node_modules/")) queue.push(next);
  }
  // Écrans chargés d'office par le routeur (tableau de bord, connexion) : restent avec lui dans l'entrée.
  for (const id of getModuleInfo(slash(path.resolve(__dirname, "src/App.tsx")))?.importedIds ?? []) if (slash(id).includes("/src/pages/")) keep.add(slash(id));
  shell = new Set([...seen].filter((id) => !keep.has(slash(id))));
  return shell;
}

export default defineConfig(({ mode }) => ({
  envDir,
  plugins: [
    buildVersion(),
    react(),
    tailwindcss(),
    offlineOrigin(mode),
    // Enveloppe hors ligne : service worker écrit à la main (push + Workbox), enregistré par src/lib/sw-register.ts.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "sw",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
      includeManifestIcons: false,
      injectManifest: {
        rollupFormat: "iife",
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2,webmanifest}"],
        // Lecteur PDF (pdf.js) compris : tous les écrans s'ouvrent hors ligne.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@kouzia/forms": path.resolve(__dirname, "../../packages/kouzia-forms/src/index.ts"),
      "@kouzia-erp/email-sanitize": path.resolve(
        __dirname,
        "../api/src/lib/email/sanitize-html.ts",
      ),
      "@kouzia-erp/api-contract": path.resolve(__dirname, "../api/src/lib/api-contract.ts"),
      "@kouzia-erp/email-sender": path.resolve(
        __dirname,
        "../api/src/lib/email/sender-label.ts",
      ),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Dépendances stables dans leurs propres fichiers : chunk d'entrée sous 500 Ko, et cache
        // navigateur conservé d'un déploiement à l'autre tant qu'elles ne changent pas.
        // Code commun chargé au démarrage dans « shell », hors de l'entrée : les pages l'importent de là, et non plus de
        // l'entrée, dont l'empreinte change à chaque modification (mesuré : 50 fichiers sur 72 pour un seul libellé).
        manualChunks(id, { getModuleInfo }) {
          const n = id.split(String.fromCharCode(92)).join("/");
          if (n.includes("vite/preload-helper")) return "shell";
          // Arborescence des écrans (libellés de menu) : importée par la mise en page et la palette seulement, à part du shell.
          if (n.endsWith("/src/lib/navigation.ts")) return "navigation";
          if (!n.includes("/node_modules/")) return shellModules(getModuleInfo).has(id) ? "shell" : undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(n)) return "react";
          if (n.includes("/node_modules/react-router")) return "router";
          if (n.includes("/node_modules/@fortawesome/")) return "icons";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // Surcharge possible pour lancer une seconde instance (ex. base de démo) : API_PROXY_TARGET.
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
}));
