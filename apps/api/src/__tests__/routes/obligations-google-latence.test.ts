// Agenda Google relié et lent (300 ms par appel, comme depuis le CT) : le tableau de bord et les Réglages
// ne doivent ni attendre Google ni l'appeler pendant un GET. La synchro se fait hors requête.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const google = vi.hoisted(() => ({ appels: 0, latenceMs: 300 }));
vi.mock("@/lib/google-calendar/oauth.js", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/google-calendar/oauth.js")>();
  const attendre = async () => {
    google.appels += 1;
    await new Promise((r) => setTimeout(r, google.latenceMs));
  };
  let suivant = 0;
  const calendar = {
    events: {
      patch: async (p: { eventId: string }) => (await attendre(), { data: { id: p.eventId } }),
      insert: async () => (await attendre(), { data: { id: `evt-${++suivant}` } }),
      list: async () => (await attendre(), { data: { items: [] } }),
      delete: async () => (await attendre(), {}),
    },
  };
  return { ...reel, getAuthedCalendarClient: async () => calendar };
});

const { prisma } = await import("@/lib/prisma.js");
const { hashPassword, SESSION_COOKIE } = await import("@/lib/auth.js");
const { resetDb } = await import("../helpers/db.js");
const { seedCompanySettings } = await import("../helpers/factories.js");
const { syncObligations } = await import("@/lib/obligations/obligation-service.js");
const { reconciliationGoogleTerminee } = await import("@/lib/obligations/google-sync-scheduler.js");
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-google@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  // Activité démarrée il y a plus d'un an : déclarations URSSAF, CFE, impôt et questionnaire ouverts.
  await prisma.companySettings.updateMany({ data: { businessStartDate: new Date(Date.now() - 400 * 86_400_000) } });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
  // Obligations créées et alignées une première fois, comme le fait le worker.
  await syncObligations();
  google.appels = 0;
}, 120_000);

const chrono = async (url: string) => {
  const debut = performance.now();
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  return { statut: res.statusCode, ms: Math.round(performance.now() - debut), corps: res.json() };
};

describe("agenda Google lent : aucune attente ni aucun appel pendant un GET", () => {
  it("tableau de bord, Réglages (checklist) et obligations répondent sans appeler Google", async () => {
    const ouvertes = await prisma.obligation.count({ where: { status: { not: "DONE" } } });
    console.log(`obligations ouvertes : ${ouvertes}`);
    expect(ouvertes).toBeGreaterThan(2);
    const mesures: Array<{ url: string; statut: number; ms: number; appels: number }> = [];
    for (const url of ["/api/dashboard/overview?scope=month", "/api/checklist", "/api/obligations"]) {
      const avant = google.appels;
      const r = await chrono(url);
      mesures.push({ url, statut: r.statut, ms: r.ms, appels: google.appels - avant });
      console.log(`${url} : ${r.ms} ms, appels Google ${google.appels - avant}`);
    }
    for (const m of mesures) {
      expect(m.statut).toBe(200);
      expect(m.appels).toBe(0);
      expect(m.ms).toBeLessThan(google.latenceMs);
    }
  }, 300_000);

  it("une modification répond sans attendre Google, puis l'agenda est aligné en arrière-plan", async () => {
    const debut = performance.now();
    const res = await app.inject({ method: "PATCH", url: "/api/checklist", headers: { cookie }, payload: { cfeInitialDeclaration: true } });
    const ms = Math.round(performance.now() - debut);
    console.log(`PATCH /api/checklist : ${ms} ms, appels Google pendant la requête ${google.appels}`);
    expect(res.statusCode).toBe(200);
    expect(ms).toBeLessThan(google.latenceMs);
    await reconciliationGoogleTerminee();
    expect(google.appels).toBeGreaterThan(0);
  }, 300_000);
});
