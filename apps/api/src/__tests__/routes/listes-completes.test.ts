import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-listes@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const DAY = 86_400_000;

let app: FastifyInstance;
let cookie = "";
let clientId = "";

// 130 pièces, au-delà de l'ancienne page de 50 (et de la page maximale de 100) :
// devis 70 (40 brouillons dont 3 à relire, 30 envoyés), factures 55 (30 émises dont 12 en retard, 25 payées), avoirs 5.
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  app = await buildApp({ silent: true, serveStatic: false });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
  ({ id: clientId } = await createClient({ displayName: "Client des listes" }));
  const base = { clientId, subtotalCents: 10_000, totalCents: 10_000 };
  const data = [
    ...Array.from({ length: 40 }, (_, i) => ({ ...base, documentType: "QUOTE" as const, status: "DRAFT" as const, quoteStatus: "DRAFT" as const, offlineReviewReason: i < 3 ? "Écart relevé" : null })),
    ...Array.from({ length: 30 }, (_, i) => ({ ...base, documentType: "QUOTE" as const, status: "ISSUED" as const, quoteStatus: "SENT" as const, number: `D-2026-${String(i + 1).padStart(4, "0")}`, issueDate: new Date(Date.now() - i * DAY) })),
    ...Array.from({ length: 30 }, (_, i) => ({ ...base, documentType: "INVOICE" as const, status: "ISSUED" as const, number: `F-2026-${String(i + 1).padStart(4, "0")}`, issueDate: new Date(Date.now() - 40 * DAY), dueDate: new Date(Date.now() + (i < 12 ? -5 : 10) * DAY) })),
    ...Array.from({ length: 25 }, (_, i) => ({ ...base, documentType: "INVOICE" as const, status: "PAID" as const, number: `F-2026-${String(i + 31).padStart(4, "0")}`, issueDate: new Date(Date.now() - 60 * DAY), dueDate: new Date(Date.now() - 50 * DAY) })),
    ...Array.from({ length: 5 }, (_, i) => ({ ...base, documentType: "CREDIT_NOTE" as const, status: "ISSUED" as const, number: `A-2026-${String(i + 1).padStart(4, "0")}`, totalCents: -1_000, subtotalCents: -1_000, issueDate: new Date() })),
  ];
  await prisma.invoice.createMany({ data });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

describe("listes complètes au-delà de 50 pièces", () => {
  it("devis et factures : toute la liste sans paramètre de page", async () => {
    expect((await get("/api/invoices?type=QUOTE")).json()).toHaveLength(70);
    expect((await get("/api/invoices?type=INVOICE")).json()).toHaveLength(60);
    expect((await get(`/api/invoices?clientId=${clientId}`)).json()).toHaveLength(60);
    expect((await get(`/api/invoices?type=QUOTE&clientId=${clientId}`)).json()).toHaveLength(70);
    expect((await get("/api/invoices?type=ALL")).json()).toHaveLength(130);
  });

  it("pagination seulement sur demande, pages disjointes qui couvrent tout", async () => {
    const p1 = (await get("/api/invoices?type=ALL&page=1&pageSize=100")).json() as Array<{ id: string }>;
    const p2 = (await get("/api/invoices?type=ALL&page=2&pageSize=100")).json() as Array<{ id: string }>;
    expect(p1).toHaveLength(100);
    expect(p2).toHaveLength(30);
    expect(new Set([...p1, ...p2].map((d) => d.id)).size).toBe(130);
    expect((await get("/api/invoices?type=ALL&pageSize=500")).json()).toHaveLength(100);
  });
});

describe("paramètres de la liste validés", () => {
  it("paramètre répété, type inconnu, identifiant hors format ou clé inconnue : 400, jamais 500", async () => {
    for (const url of [
      "/api/invoices?clientId=a&clientId=b",
      "/api/invoices?type=AUTRE",
      "/api/invoices?clientId=a.b",
      "/api/invoices?page=-1",
      "/api/invoices?pageSize=abc",
      "/api/invoices?inconnu=1",
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      // Paramètre répété : refusé dès la garde d'entrée commune (« Paramètres de requête invalides »).
      expect((res.json() as { error: string }).error, url).toMatch(/^Paramètres de (liste|requête) invalides$/);
    }
    expect((await get(`/api/invoices?type=QUOTE&clientId=${clientId}`)).statusCode).toBe(200);
  });
});

describe("plafond de sécurité de la liste complète", () => {
  it("au-delà de 5 000 pièces : les 5 000 plus récentes, plafond et total signalés", async () => {
    const base = { clientId, subtotalCents: 100, totalCents: 100, documentType: "QUOTE" as const, status: "DRAFT" as const, quoteStatus: "DRAFT" as const };
    await prisma.invoice.createMany({ data: Array.from({ length: 4_931 }, () => base) });
    const res = await get("/api/invoices?type=QUOTE");
    expect(res.json()).toHaveLength(5_000);
    expect(res.headers["x-liste-tronquee"]).toBe("5000");
    expect(res.headers["x-total-count"]).toBe("5001");
    expect((await get("/api/invoices/summary?type=QUOTE")).json().total).toBe(5_001);
    const small = await get("/api/invoices?type=INVOICE");
    expect(small.headers["x-liste-tronquee"]).toBeUndefined();
    await prisma.invoice.deleteMany({ where: { documentType: "QUOTE", totalCents: 100 } });
  }, 30_000);
});

describe("synthèse des listes comptée par le serveur", () => {
  it("devis : nombres par statut et devis à relire, sur toute la base", async () => {
    const res = await get("/api/invoices/summary?type=QUOTE");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 70, byStatus: { DRAFT: 40, SENT: 30 }, overdue: 0, toReview: 3 });
  });

  it("factures : par statut et par type, avoir émis à part, échéances dépassées", async () => {
    const res = await get("/api/invoices/summary?type=INVOICE");
    expect(res.json()).toEqual({
      total: 60,
      byStatus: { ISSUED: 30, PAID: 25, CREDIT_ISSUED: 5 },
      byKind: { factures: { ISSUED: 30, PAID: 25 }, avoirs: { CREDIT_ISSUED: 5 } },
      overdue: 12,
      toReview: 0,
    });
  });

  it("type validé, route réservée à l'admin", async () => {
    expect((await get("/api/invoices/summary")).statusCode).toBe(400);
    expect((await get("/api/invoices/summary?type=CREDIT_NOTE")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/invoices/summary?type=QUOTE" })).statusCode).toBe(401);
  });
});

describe("historique des échanges d'un client", () => {
  it("plus de 50 fils : tous rendus", async () => {
    await prisma.emailThread.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({ clientId, subject: `Fil ${i}`, participants: "[]", lastMessageAt: new Date(Date.now() - i * DAY) })),
    });
    const res = await get(`/api/clients/${clientId}/emails`);
    expect((res.json() as { items: Array<{ kind: string }> }).items.filter((i) => i.kind === "thread")).toHaveLength(60);
  });
});
