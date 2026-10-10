import { assertSecurityEnv, getApiPort } from "@/lib/env.js";
import { enableWal, prisma } from "@/lib/prisma.js";
import { buildApp } from "@/app.js";
import { hydrateSettingsFromEnv } from "@/lib/settings/service.js";
import { checkPendingMigrations } from "@/lib/migration-check.js";

async function main() {
  // Compat .env legacy : AUTH_SECRET -> SESSION_SECRET (géré par assertSecurityEnv)
  assertSecurityEnv();

  await enableWal();

  // Base en retard sur le schéma : chaque requête sur une table modifiée échouerait (500).
  try {
    const pending = await checkPendingMigrations();
    if (pending.length > 0) {
      const message =
        `[boot] ${pending.length} migration(s) Prisma non appliquée(s) : ${pending.join(", ")}. ` +
        "Lancer `npm run db:deploy` (prod : `kouziactl migrate`).";
      if (process.env.NODE_ENV !== "production") {
        console.error(message);
        process.exit(1);
      }
      console.error(message);
    }
  } catch (err) {
    // Base créée par db push (sans _prisma_migrations) : contrôle impossible, pas bloquant.
    console.warn("[boot] contrôle des migrations impossible", err instanceof Error ? err.message : err);
  }

  // Écouter tôt : le healthcheck OpenRC / kouziactl ne doit pas attendre
  // hydrate + backfill (surtout sous lock SQLite avec le worker).
  const app = await buildApp();
  const port = getApiPort();

  // Arrêt propre (Ctrl+C, redémarrage de tsx watch, OpenRC) : connexions fermées, base libérée.
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`[arrêt] ${signal}`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    void app
      .close()
      .then(() => prisma.$disconnect())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => shutdown(signal));

  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API Kouzia ERP sur :${port}`);

  try {
    await hydrateSettingsFromEnv();
    const { backfillClientEmailHashes } = await import("@/lib/clients/backfill-email-hash.js");
    const n = await backfillClientEmailHashes();
    if (n > 0) app.log.info(`[boot] emailHash backfill: ${n} client(s)`);
  } catch (err) {
    app.log.warn({ err }, "[boot] hydrateSettingsFromEnv / backfill");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
