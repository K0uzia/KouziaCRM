// Hors ligne, lot 3 : créations rejouées depuis la file de l'appareil (client, devis brouillon, note de rendez-vous).
// Idempotence par clientRequestId, 401, client supprimé, adresse déjà connue, note chiffrée au repos, conflits.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createService, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-hors-ligne@kouzia.test";
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
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  // Session posée directement : la connexion a une limite de débit.
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = { cookie }) =>
  app.inject({ method: "POST", url, headers, payload });

const clientBody = (extra: Record<string, unknown> = {}) => ({ type: "B2B", companyName: "Lou Martin", firstName: "Lou", lastName: "Martin", ...extra });

const quoteBody = (clientId: string, extra: Record<string, unknown> = {}) => ({
  clientId,
  documentType: "QUOTE",
  lines: [{ description: "Site vitrine", quantity: 1, unitPriceEuros: 1200 }],
  ...extra,
});

describe("création d'un client rejouée", () => {
  it("double envoi : une seule fiche, le renvoi rend la fiche déjà créée", async () => {
    const clientRequestId = randomUUID();
    const first = await post("/api/clients", clientBody({ clientRequestId }));
    const second = await post("/api/clients", clientBody({ clientRequestId }));
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().replayed).toBe(true);
    expect(second.json().clientNumber).toBe(first.json().clientNumber);
    expect(await prisma.client.count()).toBe(1);
    // Aucun numéro consommé par le renvoi.
    const third = await post("/api/clients", clientBody({ lastName: "Durand" }));
    expect(third.json().clientNumber).toBe("CLI-0002");
  });

  it("adresse e-mail déjà connue : pas de doublon, statut « existe déjà » et fiche existante désignée", async () => {
    const existing = (await post("/api/clients", clientBody({ email: "lou@exemple.test" }))).json();
    const res = await post("/api/clients", clientBody({ email: "LOU@Exemple.test", lastName: "Autre", clientRequestId: randomUUID() }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "client_exists", client: { id: existing.id, displayName: "Lou Martin" } });
    expect(await prisma.client.count()).toBe(1);
  });

  it("clientRequestId invalide : 400", async () => {
    const res = await post("/api/clients", clientBody({ clientRequestId: "pas-un-uuid" }));
    expect(res.statusCode).toBe(400);
  });
});

describe("devis brouillon rejoué", () => {
  it("double envoi : un seul brouillon, jamais émis ni numéroté", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    const clientRequestId = randomUUID();
    const first = await post("/api/invoices", quoteBody(client.id, { clientRequestId }));
    const second = await post("/api/invoices", quoteBody(client.id, { clientRequestId }));
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().offline).toEqual({ replayed: true, conflicts: [] });
    const quotes = await prisma.invoice.findMany({ where: { documentType: "QUOTE" } });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ status: "DRAFT", quoteStatus: "DRAFT", number: null, issuedAt: null, clientRequestId });
  });

  it("client supprimé depuis la préparation : 404 client_not_found, rien de créé", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    await app.inject({ method: "DELETE", url: `/api/clients/${client.id}`, headers: { cookie } });
    const res = await post("/api/invoices", quoteBody(client.id, { clientRequestId: randomUUID() }));
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("client_not_found");
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("client modifié depuis la préparation : brouillon créé, conflit signalé", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    const seen = client.updatedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({ method: "PUT", url: `/api/clients/${client.id}`, headers: { cookie }, payload: clientBody({ phone: "0612345678" }) });
    const res = await post("/api/invoices", quoteBody(client.id, { clientRequestId: randomUUID(), clientSeenUpdatedAt: seen }));
    expect(res.statusCode).toBe(201);
    expect(res.json().offline.conflicts.map((c: { kind: string }) => c.kind)).toEqual(["client_changed"]);
  });

  it("prix d'une prestation changé : prix saisi gardé et signalé", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    const service = await createService({ name: "Site vitrine", unitPriceCents: 120000, isSubscription: false });
    await prisma.service.update({ where: { id: service.id }, data: { unitPriceCents: 150000 } });
    const res = await post(
      "/api/invoices",
      quoteBody(client.id, {
        clientRequestId: randomUUID(),
        clientSeenUpdatedAt: client.updatedAt,
        servicePricesSeen: [{ serviceId: service.id, unitPriceCents: 120000 }],
      }),
    );
    expect(res.statusCode).toBe(201);
    const { conflicts } = res.json().offline as { conflicts: Array<{ kind: string; message: string }> };
    expect(conflicts.map((c) => c.kind)).toEqual(["price_changed"]);
    expect(conflicts[0]!.message).toContain("Site vitrine");
    expect(res.json().totalCents).toBe(120000);
  });
});

describe("notes de rendez-vous", () => {
  it("note chiffrée au repos, lue en clair par l'API, double envoi sans doublon", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    const clientRequestId = randomUUID();
    const body = "Rendez-vous du jeudi : refonte du site, budget à confirmer.";
    const preparedAt = "2026-10-15T09:30:00.000Z";
    const first = await post(`/api/clients/${client.id}/notes`, { body, clientRequestId, preparedAt });
    const second = await post(`/api/clients/${client.id}/notes`, { body, clientRequestId, preparedAt });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const rows = await prisma.clientNote.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyEncrypted).not.toContain("refonte");
    expect(rows[0]!.preparedAt.toISOString()).toBe(preparedAt);
    const list = await app.inject({ method: "GET", url: `/api/clients/${client.id}/notes`, headers: { cookie } });
    expect(list.json()).toEqual([expect.objectContaining({ body, clientId: client.id })]);
  });

  it("client supprimé : 404 client_not_found ; notes supprimées avec la fiche", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    await post(`/api/clients/${client.id}/notes`, { body: "Note", clientRequestId: randomUUID() });
    await app.inject({ method: "DELETE", url: `/api/clients/${client.id}`, headers: { cookie } });
    expect(await prisma.clientNote.count()).toBe(0);
    const res = await post(`/api/clients/${client.id}/notes`, { body: "Après", clientRequestId: randomUUID() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("client_not_found");
  });

  it("note vide ou sans clientRequestId : 400", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    expect((await post(`/api/clients/${client.id}/notes`, { body: "  ", clientRequestId: randomUUID() })).statusCode).toBe(400);
    expect((await post(`/api/clients/${client.id}/notes`, { body: "Texte" })).statusCode).toBe(400);
  });
});

describe("session expirée", () => {
  it("401 sur chaque route de création et sur le journal, rien de créé", async () => {
    const created = await post("/api/clients", clientBody());
    expect(created.statusCode).toBe(201);
    const client = created.json();
    const none = {};
    const id = randomUUID();
    expect((await post("/api/clients", clientBody({ clientRequestId: id, lastName: "Sans" }), none)).statusCode).toBe(401);
    expect((await post("/api/invoices", quoteBody(client.id, { clientRequestId: randomUUID() }), none)).statusCode).toBe(401);
    expect((await post(`/api/clients/${client.id}/notes`, { body: "x", clientRequestId: randomUUID() }, none)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/clients/${client.id}/notes` })).statusCode).toBe(401);
    expect(await prisma.client.count()).toBe(1);
    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.clientNote.count()).toBe(0);
  });
});

describe("étiquette « Préparé hors ligne, à relire » (Invoice.offlineReviewReason)", () => {
  /** Devis préparé sur une fiche vue avant sa dernière modification, avec un prix catalogue changé depuis. */
  async function quoteToReview() {
    const client = (await post("/api/clients", clientBody())).json();
    const service = await createService({ name: "Site vitrine", unitPriceCents: 120000, isSubscription: false });
    await prisma.service.update({ where: { id: service.id }, data: { unitPriceCents: 150000 } });
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({ method: "PUT", url: `/api/clients/${client.id}`, headers: { cookie }, payload: clientBody({ phone: "0612345678" }) });
    const clientRequestId = randomUUID();
    const body = quoteBody(client.id, {
      clientRequestId,
      clientSeenUpdatedAt: client.updatedAt,
      servicePricesSeen: [{ serviceId: service.id, unitPriceCents: 120000 }],
    });
    const res = await post("/api/invoices", body);
    return { res, body, id: res.json().id as string };
  }

  it("posée par la création idempotente, motif court, visible sur la fiche et dans la liste ; un renvoi ne la change pas", async () => {
    const { res, body, id } = await quoteToReview();
    expect(res.statusCode).toBe(201);
    expect(res.json().offlineReviewReason).toBe("client modifié, prix changé");
    const replay = await post("/api/invoices", body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().offlineReviewReason).toBe("client modifié, prix changé");
    const detail = await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers: { cookie } });
    expect(detail.json().offlineReviewReason).toBe("client modifié, prix changé");
    const list = await app.inject({ method: "GET", url: "/api/invoices?type=QUOTE", headers: { cookie } });
    expect(list.json().find((q: { id: string }) => q.id === id).offlineReviewReason).toBe("client modifié, prix changé");
  });

  it("sans écart, ou créé en ligne sans clientRequestId : aucune étiquette", async () => {
    const client = (await post("/api/clients", clientBody())).json();
    const offline = await post("/api/invoices", quoteBody(client.id, { clientRequestId: randomUUID(), clientSeenUpdatedAt: client.updatedAt }));
    const online = await post("/api/invoices", quoteBody(client.id));
    expect(offline.json().offlineReviewReason).toBeNull();
    expect(online.json().offlineReviewReason).toBeNull();
  });

  it("« Marquer comme relu » l'efface ; 404 inconnu ; 401 sans session", async () => {
    const { id } = await quoteToReview();
    expect((await app.inject({ method: "DELETE", url: `/api/invoices/${id}/offline-review` })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/invoices/inconnu/offline-review", headers: { cookie } })).statusCode).toBe(404);
    const res = await app.inject({ method: "DELETE", url: `/api/invoices/${id}/offline-review`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).offlineReviewReason).toBeNull();
  });

  it("effacée automatiquement à l'émission du devis", async () => {
    const { id } = await quoteToReview();
    const issued = await app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: { cookie }, payload: {} });
    expect(issued.statusCode).toBe(200);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(quote.number).not.toBeNull();
    expect(quote.offlineReviewReason).toBeNull();
  });
});
