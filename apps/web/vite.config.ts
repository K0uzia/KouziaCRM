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
        manualChunks(id) {
          const n = id.split(String.fromCharCode(92)).join("/");
          if (!n.includes("/node_modules/")) return undefined;
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
