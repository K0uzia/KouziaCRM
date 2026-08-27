import { assertSecurityEnv, getApiPort } from "@/lib/env.js";
import { enableWal } from "@/lib/prisma.js";
import { buildApp } from "@/app.js";

async function main() {
  // Compat .env legacy : AUTH_SECRET -> SESSION_SECRET (géré par assertSecurityEnv)
  assertSecurityEnv();

  await enableWal();

  const app = await buildApp();

  const port = getApiPort();
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API KouziaCRM sur :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
