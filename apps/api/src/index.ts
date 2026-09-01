import { assertSecurityEnv, getApiPort } from "@/lib/env.js";
import { enableWal } from "@/lib/prisma.js";
import { buildApp } from "@/app.js";
import { hydrateSettingsFromEnv } from "@/lib/settings/service.js";

async function main() {
  // Compat .env legacy : AUTH_SECRET -> SESSION_SECRET (géré par assertSecurityEnv)
  assertSecurityEnv();

  await enableWal();
  try {
    await hydrateSettingsFromEnv();
    const { backfillClientEmailHashes } = await import("@/lib/clients/backfill-email-hash.js");
    const n = await backfillClientEmailHashes();
    if (n > 0) console.log(`[boot] emailHash backfill: ${n} client(s)`);
  } catch (err) {
    console.warn("[boot] hydrateSettingsFromEnv:", err);
  }

  const app = await buildApp();

  const port = getApiPort();
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API KouziaCRM sur :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
