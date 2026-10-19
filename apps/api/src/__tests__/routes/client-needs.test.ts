import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { MAX_NEEDS, MAX_NEEDS_DETAILS, parseNeeds } from "@/lib/clients/needs.js";
import { runTakeovers, takeoverSummary } from "@/lib/reprises/index.js";
import { resetDb } from "../helpers/db.js";
import { createService, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-besoins@kouzia.test";
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
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const createClient = (payload: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/clients",
    headers: { cookie },
    payload: { type: "B2C", lastName: "Martin", ...payload },
  });

const putNeeds = (id: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/clients/${id}/needs`, headers: { cookie }, payload: payload as object });

type NeedView = { serviceId: string; name: string; active: boolean; doneAt: string | null; createdAt: string };

const site = () => createService({ name: "Site vitrine", isSubscription: false, unitPriceCents: 90000 });
const logo = () => createService({ name: "Logo", isSubscription: false, unitPriceCents: 20000 });

describe("besoins du client (catalogue et Précisions)", () => {
  it("création avec prestations et Précisions : liées, en attente, Précisions nettoyées", async () => {
    const [s, l] = [await site(), await logo()];
    const res = await createClient({ serviceNeeds: [s.id, l.id, s.id], needsDetails: "  5 pages\r\nformulaire  " });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { serviceNeeds: NeedView[]; needsDetails: string };
    expect(body.serviceNeeds.map((n) => [n.name, n.doneAt])).toEqual([
      ["Site vitrine", null],
      ["Logo", null],
    ]);
    expect(body.needsDetails).toBe("5 pages\nformulaire");
  });

  it("création : prestation archivée ou inconnue ignorée (fiche préparée hors ligne avant l'archivage)", async () => {
    const s = await site();
    const old = await prisma.service.create({ data: { name: "Ancienne offre", unitPriceCents: 1000, active: false } });
    const res = await createClient({ serviceNeeds: [old.id, "inconnue", s.id] });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { serviceNeeds: NeedView[] }).serviceNeeds.map((n) => n.name)).toEqual(["Site vitrine"]);
  });

  it("création avec l'ancien format (appareil pas encore mis à jour) : repris dans les Précisions", async () => {
    const res = await createClient({ needs: [{ label: "Refonte" }, { label: "Logo", done: true }], needsDetails: "Budget serré" });
    expect(res.statusCode).toBe(201);
    expect(res.json().needsDetails).toBe("Budget serré\n- Refonte\n- Logo (traité)");
    expect((await prisma.client.findFirstOrThrow()).needs).toBe("[]");
  });

  it("fiche : liste remplacée en entier, date d'ajout et date « traité » gardées, Précisions inchangées si absentes", async () => {
    const [s, l] = [await site(), await logo()];
    const client = (await createClient({ serviceNeeds: [s.id], needsDetails: "Garder" })).json();
    const first = await putNeeds(client.id, { services: [{ serviceId: s.id, done: true }, { serviceId: l.id }] });
    expect(first.statusCode).toBe(200);
    const a = first.json() as { services: NeedView[]; details: string };
    expect(a.details).toBe("Garder");
    const doneAt = a.services.find((n) => n.serviceId === s.id)!.doneAt;
    expect(doneAt).not.toBeNull();

    const second = (await putNeeds(client.id, { services: [{ serviceId: s.id, done: true }], details: "" })).json() as {
      services: NeedView[];
      details: string;
    };
    expect(second.services).toHaveLength(1);
    expect(second.services[0]!.doneAt).toBe(doneAt);
    expect(second.services[0]!.createdAt).toBe(a.services[0]!.createdAt);
    expect(second.details).toBe("");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).needsDetails).toBe("");

    const reopened = (await putNeeds(client.id, { services: [{ serviceId: s.id, done: false }] })).json() as { services: NeedView[] };
    expect(reopened.services[0]!.doneAt).toBeNull();
  });

  it("fiche : prestation archivée refusée à l'ajout, gardée si déjà notée ; suppression de la prestation = archivage", async () => {
    const s = await site();
    const client = (await createClient({ serviceNeeds: [s.id] })).json();
    const listed = (await app.inject({ method: "GET", url: "/api/services", headers: { cookie } })).json() as Array<{ id: string; clientNeedsCount: number }>;
    expect(listed.find((x) => x.id === s.id)?.clientNeedsCount).toBe(1);
    const del = await app.inject({ method: "DELETE", url: `/api/services/${s.id}`, headers: { cookie } });
    expect(del.json()).toMatchObject({ ok: true, archived: true });
    const kept = (await putNeeds(client.id, { services: [{ serviceId: s.id, done: true }] })).json() as { services: NeedView[] };
    expect(kept.services[0]).toMatchObject({ name: "Site vitrine", active: false });

    const other = (await createClient({ lastName: "Durand" })).json();
    const refused = await putNeeds(other.id, { services: [{ serviceId: s.id }] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("Prestation archivée : « Site vitrine » ne peut plus être ajoutée");
    expect((await putNeeds(other.id, { services: [{ serviceId: "inconnue" }] })).statusCode).toBe(400);
  });

  it("liste et fiche : besoins et Précisions inclus ; suppression du client : besoins supprimés", async () => {
    const s = await site();
    const client = (await createClient({ serviceNeeds: [s.id], needsDetails: "Note" })).json();
    const list = (await app.inject({ method: "GET", url: "/api/clients", headers: { cookie } })).json() as Array<{
      serviceNeeds: NeedView[];
      needsDetails: string;
    }>;
    expect(list[0]!.serviceNeeds.map((n) => n.serviceId)).toEqual([s.id]);
    const one = (await app.inject({ method: "GET", url: `/api/clients/${client.id}`, headers: { cookie } })).json();
    expect(one).toMatchObject({ needsDetails: "Note", serviceNeeds: [{ serviceId: s.id, name: "Site vitrine" }] });
    await prisma.client.delete({ where: { id: client.id } });
    expect(await prisma.clientServiceNeed.count()).toBe(0);
  });

  it("validation : doublon, trop de besoins, Précisions trop longues ou à caractères de contrôle", async () => {
    const s = await site();
    const client = (await createClient()).json();
    expect((await putNeeds(client.id, { services: [{ serviceId: s.id }, { serviceId: s.id }] })).statusCode).toBe(400);
    const many = Array.from({ length: MAX_NEEDS + 1 }, (_, i) => ({ serviceId: `s${i}` }));
    expect((await putNeeds(client.id, { services: many })).statusCode).toBe(400);
    expect((await putNeeds(client.id, { services: [], details: "x".repeat(MAX_NEEDS_DETAILS + 1) })).statusCode).toBe(400);
    expect((await putNeeds(client.id, { services: [], details: "ligne\u0007" })).statusCode).toBe(400);
    expect((await putNeeds(client.id, { services: [], details: "deux\nlignes\tet tab" })).statusCode).toBe(200);
  });

  it("client inconnu : 404 ; sans session : 401", async () => {
    expect((await putNeeds("inconnu", { services: [] })).statusCode).toBe(404);
    const anon = await app.inject({ method: "PUT", url: "/api/clients/x/needs", payload: { services: [] } });
    expect(anon.statusCode).toBe(401);
  });

  it("export : besoins du catalogue et anciens besoins en lecture seule", async () => {
    const s = await site();
    const client = (await createClient({ serviceNeeds: [s.id] })).json();
    await prisma.client.update({ where: { id: client.id }, data: { needs: JSON.stringify([{ id: "1", label: "Ancien", done: true }]) } });
    const exp = (await app.inject({ method: "GET", url: `/api/clients/${client.id}/export`, headers: { cookie } })).json();
    expect(exp.client.serviceNeeds.map((n: NeedView) => n.name)).toEqual(["Site vitrine"]);
    expect(exp.legacyNeeds).toEqual([{ id: "1", label: "Ancien", done: true }]);
  });

  it("lecture tolérante de l'ancienne colonne abîmée", () => {
    expect(parseNeeds("pas du json")).toEqual([]);
    expect(parseNeeds(null)).toEqual([]);
  });
});

describe("reprise des anciens besoins", () => {
  it("Précisions remplies (« (traité) » gardé), à blanc d'abord, idempotente, sans libellé dans les comptes, date gardée", async () => {
    const legacy = (needs: Array<{ label: string; done: boolean }>) => JSON.stringify(needs.map((n, i) => ({ id: String(i), ...n })));
    const updatedAt = new Date("2026-01-02T03:04:05Z");
    const a = await prisma.client.create({
      data: { type: "B2C", displayName: "A", needs: legacy([{ label: "Refonte du site", done: false }, { label: "Logo", done: true }]), updatedAt },
    });
    const written = await prisma.client.create({ data: { type: "B2C", displayName: "B", needs: legacy([{ label: "X", done: false }]), needsDetails: "Déjà saisi" } });
    await prisma.client.create({ data: { type: "B2C", displayName: "C" } });
    await prisma.client.create({ data: { type: "B2C", displayName: "D", needs: "abîmé" } });

    const dry = await runTakeovers({ dryRun: true });
    expect(dry.needs).toEqual({ clients: 1, needs: 2, done: 1 });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: a.id } })).needsDetails).toBeNull();
    expect(takeoverSummary(dry)[3]).toBe("  besoins : 1 fiche avec Précisions, 2 besoins repris (dont 1 « traité »)");

    const real = await runTakeovers({ dryRun: false });
    expect(real.needs).toEqual(dry.needs);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.needsDetails).toBe("- Refonte du site\n- Logo (traité)");
    expect(after.updatedAt.toISOString()).toBe(updatedAt.toISOString());
    expect(parseNeeds(after.needs)).toHaveLength(2);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: written.id } })).needsDetails).toBe("Déjà saisi");
    expect(JSON.stringify(real)).not.toMatch(/Refonte|Logo/);

    expect((await runTakeovers({ dryRun: false })).needs).toEqual({ clients: 0, needs: 0, done: 0 });
  });
});
