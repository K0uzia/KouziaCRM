import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
      "@kouzia/forms": new URL("../../packages/kouzia-forms/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./src/__tests__/global-setup.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
