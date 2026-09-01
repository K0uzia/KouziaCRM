import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { getAllowedOrigins, getTrustProxy } from "@/lib/env.js";
import { originGuardPlugin } from "@/plugins/origin-guard.js";
import { authRoutes } from "@/routes/auth.js";
import { clientsRoutes } from "@/routes/clients.js";
import { invoicesRoutes } from "@/routes/invoices.js";
import { servicesRoutes } from "@/routes/services.js";
import { publicRoutes } from "@/routes/public.js";
import { obligationsRoutes } from "@/routes/obligations.js";
import { legalClausesRoutes } from "@/routes/legal-clauses.js";
import { miscRoutes } from "@/routes/misc.js";
import { settingsRoutes } from "@/routes/settings.js";
import { numberingRoutes } from "@/routes/numbering.js";
import { quotesMarketRoutes } from "@/routes/quotes-market.js";
import { subscriptionsRoutes } from "@/routes/subscriptions.js";
import { bankRoutes } from "@/routes/bank.js";
import { payoutsRoutes } from "@/routes/payouts.js";
import { webhooksRevolutRoutes } from "@/routes/webhooks-revolut.js";
import { testimonialsRoutes } from "@/routes/testimonials.js";
import { registerErrorHandler, setJsonSerializer } from "@/lib/http.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type BuildAppOptions = {
  /** Désactive les logs (tests). Défaut false. */
  silent?: boolean;
  /** Sert le build web statique (prod). Défaut true en production. */
  serveStatic?: boolean;
};

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
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
        },
    trustProxy: getTrustProxy(),
    // Les tokens PDF publics (base64url(payload).base64url(sig)) dépassent le défaut 100.
    maxParamLength: 256,
  });

  setJsonSerializer(app);
  registerErrorHandler(app);

  await app.register(helmet, {
    referrerPolicy: { policy: "no-referrer" },
    // SPA servie par l'API: CSP permissive pour assets same-origin + inline styles Tailwind.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        fontSrc: ["'self'", "data:", "https:"],
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
      },
    },
  });

  const origins = getAllowedOrigins();
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  });

  await app.register(cookie, {
    secret: process.env.SESSION_SECRET,
    parseOptions: {},
  });

  await app.register(rateLimit, {
    global: false,
  });

  await app.register(multipart, {
    limits: { fileSize: 12 * 1024 * 1024 },
  });

  await app.register(originGuardPlugin);

  await ensureDefaultLegalClauses();

  await app.register(authRoutes);
  await app.register(clientsRoutes);
  await app.register(invoicesRoutes);
  await app.register(servicesRoutes);
  await app.register(publicRoutes);
  await app.register(obligationsRoutes);
  await app.register(legalClausesRoutes);
  await app.register(miscRoutes);
  await app.register(settingsRoutes);
  await app.register(numberingRoutes);
  await app.register(quotesMarketRoutes);
  await app.register(subscriptionsRoutes);
  await app.register(bankRoutes);
  await app.register(payoutsRoutes);
  await app.register(webhooksRevolutRoutes);
  await app.register(testimonialsRoutes);

  app.get("/api/health", async () => ({ ok: true }));

  if (opts.serveStatic !== false) {
    const webDist = process.env.WEB_DIST
      ? path.resolve(process.env.WEB_DIST)
      : path.resolve(__dirname, "../../../web/dist");

    try {
      const { access } = await import("node:fs/promises");
      await access(path.join(webDist, "index.html"));
      await app.register(fastifyStatic, {
        root: webDist,
        wildcard: false,
      });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.code(404).send({ error: "Not found" });
        }
        return reply.sendFile("index.html");
      });
      app.log.info(`SPA static served from ${webDist}`);
    } catch {
      app.log.info("Pas de build web - API seule (mode dev)");
    }
  }

  return app;
}
