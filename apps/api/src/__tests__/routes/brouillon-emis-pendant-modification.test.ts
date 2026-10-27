import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : PUT /api/invoices/:id vérifiait le statut brouillon hors transaction puis réécrivait lignes et
// totaux sans condition. Une émission arrivée entre les deux (deux onglets, double envoi) laissait réécrire une facture
// numérotée, dont le PDF archivé ne correspondait plus à la base. Course reproduite : l'émission passe pendant la
// lecture des lignes existantes, entre le contrôle et l'écriture.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-course@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ silent: true, serveStatic: false });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

describe("modification d'un brouillon émis entre-temps", () => {
  it("refusée (409), lignes et total de la facture émise intacts", async () => {
    const client = await createClient({ displayName: "Client Course", type: "B2B" });
    const draft = (
      await app.inject({ method: "POST", url: "/api/invoices", headers: { cookie }, payload: { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 900 }] } })
    ).json();
    const real = prisma.invoiceLine.findMany.bind(prisma.invoiceLine);
    const spy = vi.spyOn(prisma.invoiceLine, "findMany").mockImplementationOnce((async (args: Parameters<typeof real>[0]) => {
      // L'émission passe ici, pendant la modification.
      await prisma.invoice.update({ where: { id: draft.id }, data: { status: "ISSUED", number: "F-2026-0999", issueDate: new Date() } });
      return real(args);
    }) as never);
    const res = await app.inject({
      method: "PUT",
      url: `/api/invoices/${draft.id}`,
      headers: { cookie },
      payload: { lines: [{ description: "Site réécrit", quantity: 1, unitPriceEuros: 50 }] },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(409);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
    expect(after.totalCents).toBe(90000);
    expect(after.lines.map((l) => l.description)).toEqual(["Site"]);
  });
});
