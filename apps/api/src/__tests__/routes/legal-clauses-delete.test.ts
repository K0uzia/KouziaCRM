import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Mentions légales (bug du 26/10/2026) : une clause par défaut supprimée revenait au rechargement de la liste ; aucun
// interrupteur Active. Suppression refusée si des devis émis ont figé la clause ; jamais d'échec silencieux.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-clauses@kouzia.test";
const PROPOSAL = "Abonnement avec engagement (proposition, tout rythme de paiement)";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await prisma.legalClause.deleteMany({});
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });
type Clause = { id: string; title: string; kind: string; active: boolean; required: boolean };
const list = async () => (await call("GET", "/api/legal-clauses")).json() as Clause[];

async function issuedQuote() {
  const client = await createClient({ displayName: "Client Clauses", type: "B2B" });
  const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 900 }] })).json();
  expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return prisma.invoice.findUniqueOrThrow({ where: { id: q.id } });
}

describe("Mentions légales : interrupteur et suppression", () => {
  it("clause par défaut supprimée : ne revient pas au rechargement (cause du « la suppression ne fait rien »)", async () => {
    const proposal = (await list()).find((c) => c.title === PROPOSAL)!;
    expect(proposal).toBeTruthy();
    const del = await call("DELETE", `/api/legal-clauses/${proposal.id}`);
    expect(del.statusCode, del.body).toBe(200);
    expect((await list()).some((c) => c.title === PROPOSAL)).toBe(false);
    expect((await list()).some((c) => c.title === PROPOSAL)).toBe(false);
    expect(await prisma.legalClause.count({ where: { title: PROPOSAL } })).toBe(1);
    // Supprimée : plus modifiable ni réactivable.
    expect((await call("PATCH", `/api/legal-clauses/${proposal.id}/active`, { active: true })).statusCode).toBe(404);
  });

  it("interrupteur Active : la clause désactivée n'est plus figée sur les nouveaux devis", async () => {
    const custom = (await call("POST", "/api/legal-clauses", { title: "Clause de recette", body: "Texte de recette.", kind: "CUSTOM" })).json() as Clause;
    const off = await call("PATCH", `/api/legal-clauses/${custom.id}/active`, { active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().active).toBe(false);
    const quote = await issuedQuote();
    expect(JSON.stringify(quote.legalClausesSnapshot)).not.toContain("Clause de recette");
    expect((await call("PATCH", `/api/legal-clauses/${custom.id}/active`, { active: "oui" })).statusCode).toBe(400);
  });

  it("clause figée sur des devis émis : suppression refusée avec le nombre, à désactiver", async () => {
    const custom = (await call("POST", "/api/legal-clauses", { title: "Clause figée", body: "Texte figé.", kind: "CUSTOM" })).json() as Clause;
    await issuedQuote();
    await issuedQuote();
    const del = await call("DELETE", `/api/legal-clauses/${custom.id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ code: "in_use", count: 2, error: "Utilisée sur 2 devis émis : désactivez-la plutôt." });
    expect((await list()).some((c) => c.id === custom.id)).toBe(true);
  });

  it("clause obligatoire : jamais supprimée, message clair", async () => {
    const vat = (await list()).find((c) => c.required)!;
    const del = await call("DELETE", `/api/legal-clauses/${vat.id}`);
    expect(del.statusCode).toBe(400);
    expect(del.json()).toMatchObject({ code: "required", error: "Clause légale obligatoire : désactivez-la plutôt." });
  });
});
