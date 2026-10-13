import { assertSecurityEnv, getApiPort, getTrustedProxies } from "@/lib/env.js";
import { getAdminPublicHost } from "@/lib/tunnel-hosts.js";
import { enableWal, prisma } from "@/lib/prisma.js";
import { buildApp } from "@/app.js";
import { hydrateSettingsFromEnv } from "@/lib/settings/service.js";
import { checkPendingMigrations, checkPrismaClientUpToDate } from "@/lib/migration-check.js";

// Une promesse rejetée sans gestionnaire ne doit jamais arrêter l'ERP (Node le fait par défaut) :
// on journalise, la requête concernée a déjà échoué de son côté.
process.on("unhandledRejection", (reason) => {
  console.error("[process] promesse rejetée non gérée (le serveur continue)", reason);
});

async function main() {
  // Compat .env legacy : AUTH_SECRET -> SESSION_SECRET (géré par assertSecurityEnv)
  assertSecurityEnv();

  await enableWal();

  // Tunnel actif (proxy de confiance) sans hôte admin : toute l'admin répond 404 par Internet.
  // Journal seulement : cette configuration n'est jamais exposée par /api/health.
  if (getTrustedProxies() && !getAdminPublicHost()) {
    console.warn(
      "[boot] ATTENTION : admin injoignable par le tunnel : ADMIN_PUBLIC_ORIGIN absent du .env " +
        '(ex. ADMIN_PUBLIC_ORIGIN="https://erp.kouzia.com"). Le LAN et Tailscale fonctionnent.',
    );
  }

  // Client Prisma en retard sur le schéma (migrations appliquées sans prisma generate) :
  // les tables ou champs récents seraient absents et chaque requête dessus échouerait.
  const stale = checkPrismaClientUpToDate();
  if (stale.length > 0) {
    const message =
      `[boot] client Prisma pas à jour (absents : ${stale.slice(0, 8).join(", ")}${stale.length > 8 ? "…" : ""}). ` +
      "Lancer `npx prisma generate` (dev : make dev le fait ; prod : kouziactl update).";
    if (process.env.NODE_ENV !== "production") {
      console.error(message);
      process.exit(1);
    }
    console.error(message);
  }

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
  const { vapidStatus } = await import("@/lib/push/vapid.js");
  const push = vapidStatus();
  // Sans clés VAPID, l'ERP fonctionne : seules les notifications push sont désactivées.
  if (!push.config) app.log.warn(`[boot] push désactivé : ${push.reason}`);

  try {
    await hydrateSettingsFromEnv();
    const { backfillClientEmailHashes } = await import("@/lib/clients/backfill-email-hash.js");
    const n = await backfillClientEmailHashes();
    if (n > 0) app.log.info(`[boot] emailHash backfill: ${n} client(s)`);
    const { backfillStripeModes } = await import("@/lib/stripe/mode.js");
    const modes = await backfillStripeModes();
    if (modes > 0) app.log.info(`[boot] mode Stripe complété : ${modes} identifiant(s)`);
  } catch (err) {
    app.log.warn({ err }, "[boot] hydrateSettingsFromEnv / backfill");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
