// En premier : bornes calendaires à Paris, quel que soit le fuseau de la machine.
import "@/lib/business-tz.js";
import { assertSecurityEnv, getApiPort, getTrustedProxies } from "@/lib/env.js";
import { getAdminPublicHost } from "@/lib/tunnel-hosts.js";
import { enableWal, prisma } from "@/lib/prisma.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "@/app.js";
import { startHubListener } from "@/lib/hub/server.js";
import { hydrateSettingsFromEnv } from "@/lib/settings/service.js";
import { checkPendingMigrations, checkPrismaClientUpToDate } from "@/lib/migration-check.js";
import { installExitDiagnostics } from "@/lib/process-diagnostics.js";

// Une promesse rejetée sans gestionnaire ne doit jamais arrêter l'ERP (Node le fait par défaut) :
// on journalise, la requête concernée a déjà échoué de son côté.
// Arrêt du processus toujours tracé (code, signal, mémoire) : un serveur qui s'arrête n'est plus muet.
const diagnostics = installExitDiagnostics();

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

  // Tunnel configuré sans proxy de confiance (audit du 27/10/2026) : les requêtes d'Internet sont reconnues par leur
  // hôte public (erp, api) et soumises à la 2FA, mais l'IP réelle et les limites de débit par client sont perdues.
  // Avertissement seulement : un refus de démarrer couperait l'ERP sans personne pour le relancer.
  if (process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim() && !getTrustedProxies()) {
    console.warn(
      "[boot] ATTENTION : CLOUDFLARE_TUNNEL_TOKEN présent mais TRUST_PROXY absent ou false : IP des visiteurs du tunnel " +
        'inconnue (limites de débit communes). Régler TRUST_PROXY="true" (cloudflared local) dans le .env.',
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
  let hub: FastifyInstance | null = null;
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    diagnostics.noteSignal(signal);
    app.log.info(`[arrêt] ${signal}`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    void Promise.all([app.close(), hub?.close()])
      .then(() => prisma.$disconnect())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => shutdown(signal));

  // Hachages de recherche des e-mails recalculés AVANT d'écouter (passage à la sous-clé dédiée, 27/10/2026) : une
  // connexion à l'espace client ne doit jamais chercher avec l'ancien hachage. Quelques centaines de lignes au plus.
  try {
    const { backfillClientEmailHashes } = await import("@/lib/clients/backfill-email-hash.js");
    const n = await backfillClientEmailHashes();
    if (n > 0) console.log(`[boot] emailHash recalculé : ${n} ligne(s)`);
  } catch (err) {
    console.error("[boot] recalcul des emailHash impossible", err instanceof Error ? err.message : err);
  }

  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API Kouzia ERP sur :${port}`);
  // Écouteur du hub (réseau local seulement) : une erreur de configuration ne coupe pas l'ERP.
  try {
    hub = await startHubListener(app.log);
  } catch (err) {
    app.log.error(`[hub] écouteur non démarré : ${err instanceof Error ? err.message : String(err)}`);
  }
  // Moteur publicodes (cotisations URSSAF) construit au démarrage : ~250 ms de calcul synchrone qui
  // bloquaient sinon la première requête du tableau de bord, et toute l'API pendant ce temps.
  setImmediate(() => {
    void import("@/lib/publicodes.js").then(({ computeSocialChargesForEncaisse }) => computeSocialChargesForEncaisse(100_000));
  });
  const { vapidStatus } = await import("@/lib/push/vapid.js");
  const push = vapidStatus();
  // Sans clés VAPID, l'ERP fonctionne : seules les notifications push sont désactivées.
  if (!push.config) app.log.warn(`[boot] push désactivé : ${push.reason}`);
  // Données de langue de l'hôte : sur Alpine sans icu-data-full, Intl ne sait pas le français. Les documents
  // n'en dépendent plus (lib/format-fr), mais le serveur est signalé : /api/health et kouziactl status.
  const { intlDataStatus } = await import("@/lib/format-fr.js");
  const intl = intlDataStatus();
  if (intl.status !== "complet") {
    app.log.error(
      `[boot] données de langue incomplètes : Intl fr-FR donne « ${intl.sample} » au lieu de « 1 190,00 € ». Installer icu-data-full (apk add icu-data-full) puis redémarrer.`,
    );
  }

  try {
    await hydrateSettingsFromEnv();
    const { backfillStripeModes } = await import("@/lib/stripe/mode.js");
    const modes = await backfillStripeModes();
    if (modes > 0) app.log.info(`[boot] mode Stripe complété : ${modes} identifiant(s)`);
    const { reconcileCreditedInvoiceStatuses } = await import("@/lib/invoices/reconcile-status.js");
    const reconciled = await reconcileCreditedInvoiceStatuses();
    if (reconciled.length > 0) app.log.info(`[boot] statut recalculé (avoirs compris) : ${reconciled.join(", ")}`);
  } catch (err) {
    app.log.warn({ err }, "[boot] hydrateSettingsFromEnv / backfill");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
