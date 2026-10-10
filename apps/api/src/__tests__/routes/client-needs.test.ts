import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { MAX_NEEDS, parseNeeds } from "@/lib/clients/needs.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

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

const putNeeds = (id: string, needs: unknown) =>
  app.inject({ method: "PUT", url: `/api/clients/${id}/needs`, headers: { cookie }, payload: { needs } });

describe("besoins du client", () => {
  it("création avec besoins : libellés nettoyés, identifiants attribués, ordre gardé", async () => {
    const res = await createClient({ needs: [{ label: "  Site vitrine   5 pages " }, { label: "Logo" }] });
    expect(res.statusCode).toBe(201);
    const { needs } = res.json() as { needs: Array<{ id: string; label: string; done: boolean }> };
    expect(needs.map((n) => n.label)).toEqual(["Site vitrine 5 pages", "Logo"]);
    expect(needs.every((n) => n.id && n.done === false)).toBe(true);
  });

  it("création sans besoins : liste vide", async () => {
    const res = await createClient();
    expect(res.json().needs).toEqual([]);
  });

  it("édition depuis la fiche : ordre, libellé et « traité » remplacés en entier", async () => {
    const client = (await createClient({ needs: [{ label: "A" }, { label: "B" }] })).json();
    const [a, b] = client.needs;
    const res = await putNeeds(client.id, [
      { ...b, done: true },
      { ...a, label: "A modifié" },
      { label: "C" },
    ]);
    expect(res.statusCode).toBe(200);
    const saved = parseNeeds((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).needs);
    expect(saved.map((n) => [n.label, n.done])).toEqual([
      ["B", true],
      ["A modifié", false],
      ["C", false],
    ]);
    expect(saved[0]!.id).toBe(b.id);
  });

  it("modification de la fiche sans la liste : besoins conservés", async () => {
    const client = (await createClient({ needs: [{ label: "Garder" }] })).json();
    const res = await app.inject({
      method: "PUT",
      url: `/api/clients/${client.id}`,
      headers: { cookie },
      payload: { type: "B2C", lastName: "Martin-Dupont" },
    });
    expect(res.statusCode).toBe(200);
    expect(parseNeeds((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).needs)).toHaveLength(1);
  });

  it("validation : libellé vide, trop long, caractères de contrôle, trop de besoins", async () => {
    const client = (await createClient()).json();
    expect((await putNeeds(client.id, [{ label: "   " }])).statusCode).toBe(400);
    expect((await putNeeds(client.id, [{ label: "x".repeat(201) }])).statusCode).toBe(400);
    expect((await putNeeds(client.id, [{ label: "ligne\u0007" }])).statusCode).toBe(400);
    const many = Array.from({ length: MAX_NEEDS + 1 }, (_, i) => ({ label: `B${i}` }));
    expect((await putNeeds(client.id, many)).statusCode).toBe(400);
    expect((await putNeeds(client.id, many.slice(0, MAX_NEEDS))).statusCode).toBe(200);
  });

  it("client inconnu : 404 ; sans session : 401", async () => {
    expect((await putNeeds("inconnu", [])).statusCode).toBe(404);
    const anon = await app.inject({ method: "PUT", url: "/api/clients/x/needs", payload: { needs: [] } });
    expect(anon.statusCode).toBe(401);
  });

  it("lecture tolérante d'une colonne abîmée", () => {
    expect(parseNeeds("pas du json")).toEqual([]);
    expect(parseNeeds(null)).toEqual([]);
  });
});
