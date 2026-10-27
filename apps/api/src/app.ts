import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import { constants as zlibConstants } from "node:zlib";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { getAdminOrigins, getAllowedOrigins, getCookieSecure, getTrustedProxies, isPublicApiPath } from "@/lib/env.js";
import { routePath } from "@/lib/route-path.js";
import { registerClientIpHook, trustProxyFn } from "@/lib/client-ip.js";
import { registerTunnelHostGuard } from "@/lib/tunnel-hosts.js";
import { pendingMigrationCount } from "@/lib/migration-check.js";
import { originGuardPlugin } from "@/plugins/origin-guard.js";
import { authRoutes } from "@/routes/auth.js";
import { clientsRoutes } from "@/routes/clients.js";
import { invoicesRoutes } from "@/routes/invoices.js";
import { servicesRoutes } from "@/routes/services.js";
import { publicRoutes } from "@/routes/public.js";
import { portalTestimonialsRoutes } from "@/routes/portal-testimonials.js";
import { obligationsRoutes } from "@/routes/obligations.js";
import { legalClausesRoutes } from "@/routes/legal-clauses.js";
import { miscRoutes } from "@/routes/misc.js";
import { ownerPayRoutes } from "@/routes/owner-pay.js";
import { settingsRoutes } from "@/routes/settings.js";
import { numberingRoutes } from "@/routes/numbering.js";
import { quotesMarketRoutes } from "@/routes/quotes-market.js";
import { subscriptionsRoutes } from "@/routes/subscriptions.js";
import { stripePayoutsRoutes } from "@/routes/stripe-payouts.js";
import { webhooksStripeRoutes } from "@/routes/webhooks-stripe.js";
import { webhooksSiteRoutes } from "@/routes/webhooks-site.js";
import { siteRoutes } from "@/routes/site.js";
import { softwareRequestsRoutes } from "@/routes/software-requests.js";
import { siteEditorRoutes } from "@/routes/site-editor.js";
import { previewWebOrigin, sitePreviewRoutes } from "@/routes/site-preview.js";
import { emailReviewRoutes } from "@/routes/email-review.js";
import { emailTemplatesRoutes } from "@/routes/email-templates.js";
import { promoCodesRoutes } from "@/routes/promo-codes.js";
import { projectsRoutes } from "@/routes/projects.js";
import { notificationsRoutes } from "@/routes/notifications.js";
import { pushRoutes } from "@/routes/push.js";
import { googleCalendarRoutes } from "@/routes/google-calendar.js";
import { RATE_LIMITED, registerErrorHandler, setJsonSerializer } from "@/lib/http.js";
import { logSerializers } from "@/lib/log-redact.js";
import { registerInputGuards } from "@/lib/http-input.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { withOfflineOrigin } from "@/lib/spa-index.js";
import { API_CONTRACT, BUILD_HEADER, CONTRACT_HEADER } from "@/lib/api-contract.js";
import { intlDataStatus } from "@/lib/format-fr.js";
import { installNoBrotliFetch } from "@/lib/http/no-brotli-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Identifiant du build de l'interface (dist/version.json), null si absent (dev, build ancien). */
async function readWebBuildId(): Promise<string | null> {
  const webDist = process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : path.resolve(__dirname, "../../../web/dist");
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(path.join(webDist, "version.json"), "utf8")) as { build?: unknown };
    return typeof parsed.build === "string" && /^[a-z0-9-]{1,40}$/.test(parsed.build) ? parsed.build : null;
  } catch {
    return null;
  }
}

/** Fichier produit par Vite dans /assets, au nom hashé : son contenu ne change jamais. */
const isHashedAsset = (filePath: string) => /[\\/]assets[\\/][^\\/]+$/.test(filePath);

export type BuildAppOptions = {
  /** Désactive les logs (tests). Défaut false. */
  silent?: boolean;
  /** Sert le build web statique (prod). Défaut true en production. */
  serveStatic?: boolean;
  /** Flux du journal (tests : lecture des lignes écrites). Défaut : sortie standard. */
  logStream?: { write(line: string): void };
};

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Réponses des services extérieurs jamais demandées en Brotli (CVE-2026-111497).
  installNoBrotliFetch();
  const trustedProxies = getTrustedProxies();
  const app = Fastify({
    logger: opts.silent
      ? false
      : {
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.body.accessCode",
              "req.body.code",
              "req.query.accessCode",
              "req.query.code",
              "req.query.reference",
              "req.params.token",
            ],
            censor: "[redacted]",
          },
          // URL journalisée sans jeton (liens publics, ?code= OAuth) : voir log-redact.ts.
          serializers: logSerializers,
          ...(opts.logStream ? { stream: opts.logStream } : {}),
        },
    trustProxy: trustProxyFn(trustedProxies),
    // Les tokens PDF publics (base64url(payload).base64url(sig)) dépassent le défaut 100.
    routerOptions: { maxParamLength: 256 },
  });
  // Avant toute route et toute limite de débit : request.ip doit être l'IP réelle.
  registerClientIpHook(app, trustedProxies);
  registerTunnelHostGuard(app);

  setJsonSerializer(app);
  registerErrorHandler(app);

  // Compression Brotli ou gzip (JSON et statique), utile par Tailscale et par le tunnel au téléphone. Qualité Brotli
  // modérée : le CT a peu de processeur et les réponses sont recompressées à chaque envoi.
  await app.register(compress, {
    encodings: ["br", "gzip"],
    // Corps de requête : jamais décompressés en Brotli (CVE-2026-111497, décodeur Brotli de Node, 21/10/2026) ;
    // Content-Encoding br reçoit 415. La compression Brotli des réponses n'utilise pas le décodeur.
    requestEncodings: ["gzip", "deflate"],
    threshold: 1024,
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
  });

  // Headers « HTTPS only » (COOP, OAC, HSTS) : ne jamais les envoyer en HTTP LAN.
  // Sinon Chrome ignore COOP et spam la console (origine IP non « trustworthy »).
  // Priorité à WEB_ORIGIN : http:// → headers off, même si COOKIE_SECURE est mal réglé.
  const webOrigin = (process.env.WEB_ORIGIN ?? "").trim().toLowerCase();
  const httpsMode = webOrigin.startsWith("https://")
    ? true
    : webOrigin.startsWith("http://")
      ? false
      : getCookieSecure();
  await app.register(helmet, {
    referrerPolicy: { policy: "no-referrer" },
    hsts: httpsMode,
    crossOriginOpenerPolicy: httpsMode ? { policy: "same-origin" } : false,
    // false = désactivé ; true activerait le header (voir helmet originAgentCluster switch)
    originAgentCluster: httpsMode === true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        // Polices locales seulement (aucune police de CDN, charte).
        fontSrc: ["'self'", "data:"],
        frameSrc: ["'self'", "blob:", "data:"],
        connectSrc: [
          "'self'",
          "https://geo.api.gouv.fr",
          "https://api-adresse.data.gouv.fr",
          "https://recherche-entreprises.api.gouv.fr",
        ],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  });

  const corsFor = (origins: string[]) => ({
    origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      if (!origin || origins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
    // Défaut de @fastify/cors : GET, HEAD, POST. PUT et DELETE servent au témoignage depuis /suivi (kouzia.com).
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
  });
  // Site public admis sur /api/public/* seulement ; l'admin n'accepte que ses propres origines (audit du 27/10/2026).
  const publicCors = corsFor(getAllowedOrigins());
  const adminCors = corsFor(getAdminOrigins());
  // Aperçu du brouillon (lot 5b, contrat du site) : page /apercu du site seulement (et le site local en développement),
  // GET, jeton en en-tête Authorization (préflight), sans cookie.
  const previewOrigins = [previewWebOrigin(), "http://localhost:4321", "http://127.0.0.1:4321"].filter((o): o is string => Boolean(o));
  const previewCors = { origin: previewOrigins, credentials: false, methods: ["GET"], allowedHeaders: ["authorization"] };
  await app.register(cors, {
    delegator: (request, cb) => {
      const path = routePath(request);
      cb(null, path.startsWith("/api/public/preview/") ? previewCors : isPublicApiPath(path) ? publicCors : adminCors);
    },
  });

  await app.register(cookie, {
    secret: process.env.SESSION_SECRET,
    parseOptions: {},
  });

  // Limite de débit dépassée : erreur 429 mise en forme par registerErrorHandler ({ error } en français).
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(RATE_LIMITED), { statusCode: context.statusCode }),
  });

  await app.register(multipart, {
    limits: { fileSize: 12 * 1024 * 1024 },
  });

  await app.register(originGuardPlugin);
  registerInputGuards(app);

  // Réponses de l'API jamais mises en cache, sauf en-tête posé par la route (médias du site).
  // Toutes les réponses : fonctions sensibles du navigateur coupées, rien d'indexable (admin et API).
  // Version de l'interface servie (dist/version.json écrit au build) et numéro du contrat : une interface plus
  // ancienne que le serveur le voit à la première réponse et propose (ou impose) le rechargement.
  const buildId = opts.serveStatic === false ? null : await readWebBuildId();
  app.addHook("onSend", async (request, reply, payload) => {
    const api = routePath(request).startsWith("/api/");
    if (api) {
      reply.header(CONTRACT_HEADER, String(API_CONTRACT));
      if (buildId) reply.header(BUILD_HEADER, buildId);
    }
    if (api && !reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });

  await ensureDefaultLegalClauses();

  await app.register(authRoutes);
  await app.register(clientsRoutes);
  await app.register(invoicesRoutes);
  await app.register(servicesRoutes);
  await app.register(publicRoutes);
  await app.register(portalTestimonialsRoutes);
  await app.register(obligationsRoutes);
  await app.register(legalClausesRoutes);
  await app.register(miscRoutes);
  await app.register(ownerPayRoutes);
  await app.register(settingsRoutes);
  await app.register(numberingRoutes);
  await app.register(quotesMarketRoutes);
  await app.register(subscriptionsRoutes);
  await app.register(stripePayoutsRoutes);
  await app.register(webhooksStripeRoutes);
  await app.register(webhooksSiteRoutes);
  await app.register(projectsRoutes);
  await app.register(notificationsRoutes);
  await app.register(pushRoutes);
  await app.register(googleCalendarRoutes);
  await app.register(siteRoutes);
  await app.register(softwareRequestsRoutes);
  await app.register(siteEditorRoutes);
  await app.register(sitePreviewRoutes);
  await app.register(emailReviewRoutes);
  await app.register(emailTemplatesRoutes);
  await app.register(promoCodesRoutes);

  // pendingMigrations > 0 : base en retard sur le code (contrôle d'après déploiement).
  // Par le tunnel : état seulement (l'avance des migrations ne regarde que le LAN, kouziactl compris).
  // intl : « incomplet » si l'hôte n'a pas les données de langue françaises (Alpine sans icu-data-full).
  const intl = intlDataStatus().status;
  app.get("/api/health", async (request) =>
    request.viaTunnel ? { ok: true } : { ok: true, pendingMigrations: pendingMigrationCount(), intl },
  );

  let spaServed = false;
  if (opts.serveStatic !== false) {
    const webDist = process.env.WEB_DIST
      ? path.resolve(process.env.WEB_DIST)
      : path.resolve(__dirname, "../../../web/dist");

    try {
      const { access, readFile } = await import("node:fs/promises");
      const indexFile = path.join(webDist, "index.html");
      await access(indexFile);
      // index.html porte l'origine du hors ligne de ce serveur : jamais servi tel quel par le statique.
      const sendIndex = async (reply: FastifyReply) =>
        reply
          .header("Cache-Control", "no-cache")
          .type("text/html; charset=utf-8")
          .send(withOfflineOrigin(await readFile(indexFile, "utf8"), process.env.ADMIN_PUBLIC_ORIGIN));
      await app.register(fastifyStatic, {
        root: webDist,
        wildcard: false,
        cacheControl: false,
        index: false,
        allowedPath: (pathname) => pathname !== "/index.html",
        // Fichiers hashés de /assets : un an, immuables. Le reste (index.html, sw.js, manifeste) est
        // revalidé à chaque chargement, pour qu'une mise à jour soit prise tout de suite.
        setHeaders: (reply, filePath) => {
          reply.header("Cache-Control", isHashedAsset(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
        },
      });
      app.setNotFoundHandler((request, reply) => {
        const pathname = request.url.split("?")[0]!;
        if (pathname === "/index.html") return sendIndex(reply);
        // Un fichier absent (ancien chunk après une mise à jour) répond 404 : servi à sa place,
        // index.html ferait échouer l'import du module sans erreur exploitable par la SPA.
        if (pathname.startsWith("/api/") || pathname.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(pathname)) {
          return reply.code(404).send({ error: "Not found" });
        }
        return sendIndex(reply);
      });
      spaServed = true;
      app.log.info(`SPA static served from ${webDist}`);
    } catch {
      app.log.info("Pas de build web - API seule (mode dev)");
    }
  }
  if (!spaServed) {
    // Même corps de 404 qu'avec la SPA (le garde d'hôte du tunnel s'aligne dessus).
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));
  }

  return app;
}
