import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  envDir: path.resolve(__dirname, "../.."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@kouzia/forms": path.resolve(__dirname, "../../packages/kouzia-forms/src/index.ts"),
      "@kouzia-erp/email-sanitize": path.resolve(
        __dirname,
        "../api/src/lib/email/sanitize-html.ts",
      ),
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
});
