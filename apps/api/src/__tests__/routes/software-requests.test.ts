import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { issueFormToken } from "@/lib/software-requests/service.js";
import { listNotifications } from "@/lib/notifications/feed.js";
import { purgeRetention } from "@/lib/privacy/retention.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars!!";
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-demandes@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
const EMAIL = "camille@atelier.example";
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

/** Jeton d'un formulaire affiché il y a 10 s (au-delà du délai minimal). */
const shownTenSecondsAgo = () => issueFormToken(Date.now() - 10_000);
const body = (extra: Record<string, unknown> = {}) => ({
  software: "tracebay",
  company: "Atelier Martin",
  name: "Camille Martin",
  email: EMAIL,
  phone: "06 12 34 56 78",
  edition: "SERVER",
  seats: "2_5",
  need: "Suivre les lots de production et leurs contrôles qualité.",
  duration: "6_MONTHS",
  noticeVersion: "a1b2c3d4e5f6",
  token: shownTenSecondsAgo(),
  website: "",
  ...extra,
});
// Une adresse par test : la limite de 5 envois par 15 minutes vaut par IP.
let ip = 0;
beforeEach(() => {
  ip++;
});
const submit = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/public/software-requests", payload, remoteAddress: `192.168.50.${ip}` });
const admin = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

describe("POST /api/public/software-requests (demande Tracebay depuis le site)", () => {
  it("jeton puis demande valide : 201, données personnelles chiffrées, notification dans la cloche", async () => {
    const token = await app.inject({ method: "GET", url: "/api/public/software-requests/token" });
    expect(token.statusCode).toBe(200);
    expect(token.json().token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);

    const res = await submit(body());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    const row = await prisma.softwareRequest.findFirstOrThrow();
    expect(row).toMatchObject({ software: "TRACEBAY", status: "PENDING", companyName: "Atelier Martin", seats: "2_5", duration: "6_MONTHS", noticeVersion: "a1b2c3d4e5f6" });
    expect(row.emailHash).toBe(computeEmailHash(EMAIL));
    expect(`${row.emailEncrypted}${row.contactNameEncrypted}${row.phoneEncrypted}`).not.toMatch(/camille|Camille|06 12/);

    const feed = await listNotifications(new Date(Date.now() - 60_000));
    expect(feed.find((i) => i.kind === "software_request")).toMatchObject({
      title: "Demande Tracebay : Atelier Martin",
      href: `/demandes-logiciel/${row.id}`,
    });
  });

  it("pot de miel ou envoi en moins de 3 s : même 201, rien n'est enregistré", async () => {
    expect((await submit(body({ website: "https://spam.example" }))).statusCode).toBe(201);
    expect((await submit(body({ token: issueFormToken() }))).statusCode).toBe(201);
    expect(await prisma.softwareRequest.count()).toBe(0);
  });

  it("jeton faux ou de plus de 2 h : 400 token_invalid ; champ invalide : 400 validation avec fieldErrors", async () => {
    const forged = await submit(body({ token: `${Date.now() - 10_000}.faux` }));
    expect(forged.statusCode).toBe(400);
    expect(forged.json().code).toBe("token_invalid");
    const old = await submit(body({ token: issueFormToken(Date.now() - 3 * 3_600_000) }));
    expect(old.json().code).toBe("token_invalid");

    const invalid = await submit(body({ seats: "12", duration: "1_MONTH", consent: true }));
    const noEdition = await submit(body({ edition: undefined, token: shownTenSecondsAgo() }));
    expect(noEdition.json().error.fieldErrors.edition).toBeDefined();
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("validation");
    expect(await prisma.softwareRequest.count()).toBe(0);
  });

  it("même demandeur dans les 24 h : la demande en attente est complétée, pas dupliquée", async () => {
    await submit(body());
    await submit(body({ email: EMAIL.toUpperCase(), seats: "6_20", token: shownTenSecondsAgo() }));
    const rows = await prisma.softwareRequest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seats).toBe("6_20");
  });
});

describe("demandes de logiciel dans l'ERP", () => {
  it("sans session : 401 ; liste avec compteurs ; fiche avec le client proposé par son e-mail", async () => {
    expect((await app.inject({ method: "GET", url: "/api/software-requests" })).statusCode).toBe(401);
    await submit(body());
    const known = await createClient({ displayName: "Atelier Martin" });
    await prisma.client.update({ where: { id: known.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });

    const list = await admin("GET", "/api/software-requests?status=PENDING");
    expect(list.statusCode).toBe(200);
    expect(list.json().counts).toEqual({ PENDING: 1, CONVERTED: 0, DECLINED: 0 });
    const item = list.json().items[0];
    expect(item).toMatchObject({ companyName: "Atelier Martin", contactName: "Camille Martin", status: "PENDING" });
    expect(item).not.toHaveProperty("email");

    const detail = await admin("GET", `/api/software-requests/${item.id}`);
    expect(detail.json()).toMatchObject({ email: EMAIL, phone: "06 12 34 56 78", edition: "SERVER", suggestedClient: { id: known.id } });
    expect((await admin("GET", "/api/software-requests/inconnue")).statusCode).toBe(404);
  });

  it("rattachement à un client : convertie ; refus d'une autre : refusée, une seule fois", async () => {
    await submit(body());
    await submit(body({ email: "autre@example.test", token: shownTenSecondsAgo() }));
    const [a, b] = await prisma.softwareRequest.findMany({ orderBy: { createdAt: "asc" } });
    const client = await createClient({ displayName: "Atelier Martin" });

    const linked = await admin("POST", `/api/software-requests/${a!.id}/link`, { clientId: client.id });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ status: "CONVERTED", client: { id: client.id } });
    expect((await admin("POST", `/api/software-requests/${a!.id}/link`, { clientId: client.id })).statusCode).toBe(409);

    expect((await admin("POST", `/api/software-requests/${b!.id}/decline`)).json().status).toBe("DECLINED");
    expect((await admin("POST", `/api/software-requests/${b!.id}/decline`)).statusCode).toBe(409);
  });

  it("conservation : non convertie sans échange depuis 3 ans supprimée, convertie gardée", async () => {
    const client = await createClient({ displayName: "Atelier Martin" });
    const old = new Date(Date.now() - 4 * 365 * 86_400_000);
    const base = {
      software: "TRACEBAY",
      companyName: "X",
      contactNameEncrypted: encrypt("X"),
      emailEncrypted: encrypt("x@example.test"),
      emailHash: computeEmailHash("x@example.test")!,
      edition: "UNSURE",
      seats: "1",
      need: "Besoin de test pour la conservation.",
      duration: "UNSURE",
      noticeVersion: "a1b2c3d4e5f6",
    };
    await prisma.softwareRequest.create({ data: { ...base, status: "DECLINED" } });
    await prisma.softwareRequest.create({ data: { ...base, status: "CONVERTED", clientId: client.id } });
    await prisma.$executeRawUnsafe(`UPDATE "SoftwareRequest" SET "updatedAt" = ${old.getTime()}`);
    const purged = await purgeRetention();
    expect(purged.softwareRequests).toBe(1);
    expect((await prisma.softwareRequest.findMany()).map((r) => r.status)).toEqual(["CONVERTED"]);
  });
});
