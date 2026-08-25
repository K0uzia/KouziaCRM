import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { assertSecurityEnv, getApiPort, getAllowedOrigins } from "@/lib/env.js";
import { originGuardPlugin } from "@/plugins/origin-guard.js";
import { authRoutes } from "@/routes/auth.js";
import { clientsRoutes } from "@/routes/clients.js";
import { invoicesRoutes } from "@/routes/invoices.js";
import { servicesRoutes } from "@/routes/services.js";
import { publicRoutes } from "@/routes/public.js";
import { obligationsRoutes } from "@/routes/obligations.js";
import { legalClausesRoutes } from "@/routes/legal-clauses.js";
import { miscRoutes } from "@/routes/misc.js";
import { numberingRoutes } from "@/routes/numbering.js";
import { quotesMarketRoutes } from "@/routes/quotes-market.js";
import { enableWal } from "@/lib/prisma.js";
import { registerErrorHandler, setJsonSerializer } from "@/lib/http.js";
import multipart from "@fastify/multipart";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Compat .env legacy : AUTH_SECRET → SESSION_SECRET
  if (!process.env.SESSION_SECRET && process.env.AUTH_SECRET) {
    process.env.SESSION_SECRET = process.env.AUTH_SECRET;
  }

  assertSecurityEnv();
  await enableWal();

  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  setJsonSerializer(app);
  registerErrorHandler(app);

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  const origins = getAllowedOrigins();
  await app.register(cors, {
    origin: (origin, cb) => {
      // Ne pas throw: @fastify/cors transforme l'Error en HTTP 500
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
  await app.register(numberingRoutes);
  await app.register(quotesMarketRoutes);

  app.get("/api/health", async () => ({ ok: true }));

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

  const port = getApiPort();
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`API KouziaCRM sur :${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
