import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Dates du jour et bornes de mois en heure de Paris (P1 du 26/10/2026) : horloge simulée à 00 h 30 à Paris, en hiver
// (UTC+1) et en été (UTC+2), quand le jour UTC est encore la veille.
const { parisIsoDate } = await import("@/lib/format-fr.js");
const { currentMonth } = await import("@/lib/finance/dates.js");
const { receiptsPeriod } = await import("@/lib/obligations/receipts.js");
const { receiptFileName } = await import("@/lib/pdf/receipt-archive.js");

const CASES = [
  { label: "hiver", at: new Date("2026-11-30T23:30:00Z"), paris: "2026-12-01", month: 12, previous: 11 },
  { label: "été", at: new Date("2026-07-31T22:30:00Z"), paris: "2026-08-01", month: 8, previous: 7 },
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("jour et mois à Paris, horloge à 00 h 30 (veille en UTC)", () => {
  it("le fuseau de l'entreprise est imposé même si la machine démarre en UTC", () => {
    const api = path.resolve(import.meta.dirname, "../../..");
    const script = [
      'await import("./src/lib/business-tz.ts");',
      'const at = (iso) => new Date(iso);',
      'console.log([at("2026-11-30T23:30:00Z").getDate(), at("2026-07-31T22:30:00Z").getDate(), process.env.TZ].join(","));',
    ].join(" ");
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: api, env: { ...process.env, TZ: "UTC" }, encoding: "utf8" });
    expect(out.trim()).toBe("1,1,Europe/Paris");
  });

  for (const c of CASES) {
    it(`${c.label} : jour, mois en cours, bornes du livre des recettes et nom du reçu`, () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(c.at);
      expect(parisIsoDate()).toBe(c.paris);
      expect(currentMonth().month).toBe(c.month);
      const month = receiptsPeriod({ year: "2026", month: String(c.month) });
      expect(c.at >= month.start && c.at <= month.end).toBe(true);
      const before = receiptsPeriod({ year: "2026", month: String(c.previous) });
      expect(c.at > before.end).toBe(true);
      expect(receiptFileName("F-2026-0001", c.at, "paiement123456")).toContain(c.paris);
    });
  }
});

describe("règlement enregistré à 00 h 30 : dans le mois de Paris au livre des recettes", () => {
  const ADMIN = "admin-dates-paris@kouzia.test";
  let app: FastifyInstance;
  let cookie: string;
  beforeAll(async () => {
    const { buildApp } = await import("@/app.js");
    app = await buildApp({ silent: true, serveStatic: false });
  });
  afterAll(async () => {
    await app.close();
    await resetDb();
  });
  beforeEach(async () => {
    await resetDb();
    await seedCompanySettings();
    await prisma.user.deleteMany({ where: { email: ADMIN } });
    await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  });
  // Connexion à l'heure simulée : une session ouverte à l'heure réelle aurait expiré au 30 novembre.
  const login = async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
    cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
    // createdAt est posé par Prisma à l'heure réelle (@default(now())) : recalé sur l'heure simulée.
    await prisma.session.updateMany({ data: { createdAt: new Date() } });
  };
  const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

  for (const c of CASES) {
    it(`${c.label} : règlement du jour sans date saisie, compté dans le mois ${c.month}`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(c.at.getTime() - 3_600_000));
      await login();
      const client = await createClient({ displayName: "Client Minuit" });
      const inv = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Prestation", quantity: 1, unitPriceEuros: 100 }] })).json();
      expect((await call("POST", `/api/invoices/${inv.id}/issue`, { email: { send: false }, payment: { mode: "none" } })).statusCode).toBe(200);
      vi.setSystemTime(c.at);
      const paid = await call("POST", `/api/invoices/${inv.id}/pay`, { amountEuros: 100, notifyClient: false });
      expect(paid.statusCode, paid.body).toBe(201);
      const inMonth = (await call("GET", `/api/receipts?year=2026&month=${c.month}`)).json();
      const inPrevious = (await call("GET", `/api/receipts?year=2026&month=${c.previous}`)).json();
      expect(inMonth.rows).toHaveLength(1);
      expect(inPrevious.rows).toHaveLength(0);
    });
  }
});
