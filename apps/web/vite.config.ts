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
      "@kouziacrm/email-sanitize": path.resolve(
        __dirname,
        "../api/src/lib/email/sanitize-html.ts",
      ),
      "@kouziacrm/email-sender": path.resolve(
        __dirname,
        "../api/src/lib/email/sender-label.ts",
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
