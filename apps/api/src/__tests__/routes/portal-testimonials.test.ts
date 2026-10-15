import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { openPortalSession, PORTAL_COOKIE } from "@/lib/portal/auth.js";
import { listNotifications } from "@/lib/notifications/feed.js";
import { getAllowedOrigins } from "@/lib/env.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { CONSENT_VERSION, PROOF_RETENTION_MS, purgeTestimonialProofs, withdrawalsOnSite } from "@/lib/site/testimonials.js";
import { clearTable, resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-temoignages@kouzia.test";
let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  admin = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  for (const t of ["SiteReview", "PortalSession", "ClientProject"]) await clearTable(t);
});

/** Client avec un projet (terminé par défaut) et une session de portail ouverte. */
async function portalClient(opts: { status?: string; firstName?: string; lastName?: string; type?: "B2B" | "B2C" } = {}) {
  const client = await createClient({ displayName: "Marie Dupont", type: opts.type ?? "B2C" });
  await prisma.client.update({ where: { id: client.id }, data: { firstName: opts.firstName ?? "Marie", lastName: opts.lastName ?? "Dupont" } });
  const project = await prisma.clientProject.create({ data: { clientId: client.id, name: "Site vitrine", status: opts.status ?? "DONE" } });
  const { token } = await openPortalSession({ clientId: client.id, deviceId: `appareil-${client.id}`, ipAddress: "203.0.113.9", userAgent: "Test" });
  return { client, project, cookie: `${PORTAL_COOKIE}=${token}` };
}

const testimonial = { text: "Travail soigné, à l'écoute du début à la fin.", nameMode: "INITIAL", consent: true, consentVersion: CONSENT_VERSION };
let ip = 0;
const put = (cookie: string, projectId: string, payload: unknown = testimonial) =>
  app.inject({ method: "PUT", url: `/api/public/portal/projects/${projectId}/testimonial`, payload: payload as never, headers: { cookie, "user-agent": "Mozilla/5.0 Test" }, remoteAddress: `10.1.0.${++ip % 250}` });
const del = (cookie: string, projectId: string) =>
  app.inject({ method: "DELETE", url: `/api/public/portal/projects/${projectId}/testimonial`, headers: { cookie }, remoteAddress: `10.2.0.${++ip % 250}` });
const adminCall = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie: admin } });

describe("témoignage depuis l'espace client", () => {
  it("dépôt sur un projet terminé : « À valider », nom choisi, preuve chiffrée complète ; formulaire et état dans /suivi", async () => {
    const { client, project, cookie } = await portalClient();
    const tracking = (await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie } })).json();
    expect(tracking.testimonialForm).toMatchObject({
      nameOptions: { INITIAL: "Marie D.", FULL: "Marie Dupont" },
      consent: { version: CONSENT_VERSION },
      maxLength: 600,
    });
    expect(tracking.testimonialForm.consent.text).toMatch(/^J'accepte que ce témoignage soit publié sur kouzia\.com/);
    expect(tracking.projects[0]).toMatchObject({ id: project.id, status: "DONE", testimonial: { status: "NONE" } });

    const res = await put(cookie, project.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "PENDING", nameMode: "INITIAL" });
    const row = await prisma.siteReview.findUniqueOrThrow({ where: { projectId: project.id } });
    expect(row).toMatchObject({ source: "CLIENT_SPACE", clientId: client.id, author: "Marie D.", status: "DRAFT", consentChannel: "Espace client" });
    const proof = JSON.parse(decrypt(row.consentProofEncrypted!));
    expect(proof).toMatchObject({ consentVersion: CONSENT_VERSION, userAgent: "Mozilla/5.0 Test" });
    expect(proof.ip).toBeTruthy();
    expect(proof.portalSessionId).toBeTruthy();
    expect(row.consentProofEncrypted).not.toContain("Mozilla");

    const after = (await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie } })).json();
    expect(after.projects[0].testimonial).toMatchObject({ status: "PENDING", text: testimonial.text, nameMode: "INITIAL" });
  });

  it("refus : sans session, projet d'un autre client (404), projet non terminé, accord absent, version périmée, 601 caractères, tiret long, nom indisponible", async () => {
    const mine = await portalClient();
    const other = await portalClient();
    const active = await portalClient({ status: "ACTIVE" });
    expect((await app.inject({ method: "PUT", url: `/api/public/portal/projects/${mine.project.id}/testimonial`, payload: testimonial })).statusCode).toBe(401);
    expect((await put(mine.cookie, other.project.id)).statusCode).toBe(404);
    expect((await put(mine.cookie, "inconnu")).statusCode).toBe(404);
    expect((await put(active.cookie, active.project.id)).json()).toEqual({ error: "NOT_ELIGIBLE", message: expect.any(String) });
    for (const [bad, code] of [
      [{ consent: false }, "CONSENT_REQUIRED"],
      [{ consentVersion: "2020-01-01" }, "CONSENT_OUTDATED"],
      [{ text: "a".repeat(601) }, "TEXT_TOO_LONG"],
      [{ text: "   " }, "TEXT_EMPTY"],
      [{ text: `Bien ${String.fromCharCode(0x2014)} merci` }, "TEXT_INVALID"],
      [{ nameMode: "ORGANIZATION" }, "NAME_MODE_INVALID"],
      [{ nameMode: "AUTRE" }, "NAME_MODE_INVALID"],
      [{ autre: 1 }, "INVALID"],
    ] as const) {
      const res = await put(mine.cookie, mine.project.id, { ...testimonial, ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json(), JSON.stringify(bad)).toMatchObject({ error: code });
    }
    expect(await prisma.siteReview.count()).toBe(0);
  });

  it("un seul par projet, modifiable avant publication, figé ensuite ; structure : nom de la structure proposé", async () => {
    const { project, cookie } = await portalClient();
    await put(cookie, project.id);
    await put(cookie, project.id, { ...testimonial, text: "Texte revu.", nameMode: "FULL" });
    expect(await prisma.siteReview.count()).toBe(1);
    expect(await prisma.siteReview.findFirstOrThrow()).toMatchObject({ text: "Texte revu.", author: "Marie Dupont" });

    const row = await prisma.siteReview.findFirstOrThrow();
    expect((await adminCall("POST", `/api/site/reviews/${row.id}/publish`)).statusCode).toBe(200);
    const frozen = await put(cookie, project.id, { ...testimonial, text: "Encore changé." });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().error).toBe("ALREADY_PUBLISHED");

    const org = await portalClient({ type: "B2B" });
    await prisma.client.update({ where: { id: org.client.id }, data: { companyName: "Asso du Bourg" } });
    const form = (await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie: org.cookie } })).json().testimonialForm;
    expect(form.nameOptions).toMatchObject({ ORGANIZATION: "Asso du Bourg" });
  });

  it("retrait : non publié, effacé avec sa preuve ; publié, statut Retiré et preuve gardée", async () => {
    const a = await portalClient();
    await put(a.cookie, a.project.id);
    expect((await del(a.cookie, a.project.id)).json()).toEqual({ status: "NONE" });
    expect(await prisma.siteReview.count()).toBe(0);

    const b = await portalClient();
    await put(b.cookie, b.project.id);
    await prisma.siteReview.updateMany({ data: { status: "PUBLISHED", publishedAt: new Date() } });
    const since = new Date(Date.now() - 1000);
    expect((await del(b.cookie, b.project.id)).json()).toEqual({ status: "WITHDRAWN" });
    expect(await listNotifications(since)).toContainEqual(
      expect.objectContaining({ kind: "testimonial", title: "Témoignage retiré par son auteur", body: "Marie D., projet « Site vitrine » : à retirer du site sous 7 jours.", href: "/site" }),
    );
    const row = await prisma.siteReview.findFirstOrThrow();
    expect(row.status).toBe("WITHDRAWN");
    expect(row.withdrawalRequestedAt).not.toBeNull();
    expect(row.consentProofEncrypted).not.toBeNull();
    expect((await del(a.cookie, b.project.id)).statusCode).toBe(404);
  });

  it("preflight CORS du navigateur : PUT et DELETE autorisés pour le site, avec credentials", async () => {
    const origin = getAllowedOrigins()[0]!;
    for (const method of ["PUT", "DELETE"]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/public/portal/projects/x/testimonial",
        headers: { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" },
      });
      expect(res.statusCode, method).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(res.headers["access-control-allow-methods"])).toContain(method);
    }
  });

  it("limite de débit : 10 envois par 15 minutes et par IP", async () => {
    const { project, cookie } = await portalClient();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: "PUT", url: `/api/public/portal/projects/${project.id}/testimonial`, payload: testimonial, headers: { cookie }, remoteAddress: "192.0.2.50" })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("témoignages dans l'ERP", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await prisma.companySettings.updateMany({ data: { githubTokenEncrypted: null } });
    invalidateCompanySettingsCache();
  });

  it("retrait après publication : alerte tant que avis.json du dépôt contient le texte ; non vérifié si le dépôt est illisible", async () => {
    const { project, cookie } = await portalClient();
    await put(cookie, project.id);
    await prisma.siteReview.updateMany({ data: { status: "PUBLISHED", publishedAt: new Date() } });
    const row = await prisma.siteReview.findFirstOrThrow();
    expect(await withdrawalsOnSite()).toEqual([]);
    await del(cookie, project.id);

    // Jeton absent : retrait récent signalé sans vérification, ancien (plus de 30 jours) tu.
    expect(await withdrawalsOnSite()).toMatchObject([{ id: row.id, author: "Marie D.", verified: false }]);
    expect(await withdrawalsOnSite(new Date(Date.now() + 31 * 86_400_000))).toEqual([]);

    await prisma.companySettings.updateMany({ data: { githubTokenEncrypted: encrypt("github_pat_test") } });
    invalidateCompanySettingsCache();
    let live = [{ auteur: "Marie D.", publieLe: row.reviewedOn, texte: row.text }];
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (seen.push(String(url)), new Response(JSON.stringify({ schemaVersion: 1, avis: live })))));
    expect(await withdrawalsOnSite()).toMatchObject([{ id: row.id, verified: true }]);
    expect(seen.at(-1)).toContain("/contents/src/content/site/avis.json?ref=main");
    const status = (await adminCall("GET", "/api/site/status")).json();
    expect(status.withdrawalsOnSite).toMatchObject([{ id: row.id, author: "Marie D.", verified: true }]);

    // Publié depuis sans ce témoignage : plus d'alerte.
    live = [];
    expect(await withdrawalsOnSite()).toEqual([]);
  });

  it("retrait après publication : plus d'alerte dès qu'une publication est enregistrée dans le dépôt après le retrait", async () => {
    const { project, cookie } = await portalClient();
    await put(cookie, project.id);
    await prisma.siteReview.updateMany({ data: { status: "PUBLISHED", publishedAt: new Date() } });
    await prisma.sitePublication.create({
      data: { status: "LIVE", digest: "d", summaryJson: "[]", commitSha: "a".repeat(40), startedAt: new Date(Date.now() - 60_000) },
    });
    await del(cookie, project.id);
    // Publication antérieure au retrait : le témoignage y est encore (jeton absent : signalé, non vérifié).
    expect(await withdrawalsOnSite()).toMatchObject([{ author: "Marie D.", verified: false }]);
    // Publication échouée avant le commit : ne compte pas.
    await prisma.sitePublication.create({ data: { status: "FAILED", digest: "d", summaryJson: "[]", startedAt: new Date(Date.now() + 1000) } });
    expect(await withdrawalsOnSite()).toHaveLength(1);
    // Commit fait après le retrait (ou dépôt déjà à jour) : le retrait est publié, sans lire GitHub.
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (seen.push(String(url)), new Response("{}"))));
    await prisma.sitePublication.create({ data: { status: "NOOP", digest: "d", summaryJson: "[]", startedAt: new Date(Date.now() + 2000) } });
    expect(await withdrawalsOnSite()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("file À valider : notification, texte du client non modifiable, publier puis instantané ; écarter avec mailto neutre", async () => {
    const since = new Date(Date.now() - 1000);
    const { client, project, cookie } = await portalClient();
    await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: (await import("@/lib/crypto.js")).encrypt("marie@exemple.fr") } });
    await put(cookie, project.id);
    const row = await prisma.siteReview.findFirstOrThrow();

    const notes = await listNotifications(since);
    expect(notes).toContainEqual(expect.objectContaining({ kind: "testimonial", title: "Témoignage à valider", body: "Marie D., projet « Site vitrine »" }));

    const list = (await adminCall("GET", "/api/site/reviews")).json() as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ source: "CLIENT_SPACE", project: { name: "Site vitrine" }, consentVersion: CONSENT_VERSION, consentProof: null });
    expect(JSON.stringify(list)).not.toContain("203.0.113");

    const edit = await adminCall("PUT", `/api/site/reviews/${row.id}`, { author: "Marie D.", reviewedOn: row.reviewedOn, text: "Retouché.", clientId: client.id });
    expect(edit.statusCode).toBe(409);

    const rejected = await adminCall("POST", `/api/site/reviews/${row.id}/reject`, { reason: "Il contient un numéro de téléphone." });
    expect(rejected.statusCode).toBe(200);
    const mailto = decodeURIComponent(rejected.json().mailto as string);
    expect(mailto).toMatch(/^mailto:marie@exemple\.fr\?subject=Votre témoignage pour /);
    expect(mailto.split("&body=")[0]).not.toContain("soigné");
    expect(mailto).toContain("Il contient un numéro de téléphone.");
    expect((await adminCall("POST", `/api/site/reviews/${row.id}/reject`, { reason: "" })).statusCode).toBe(400);
    // Écarté : jamais publié, même forcé « Sur le site ».
    await prisma.siteReview.update({ where: { id: row.id }, data: { status: "PUBLISHED" } });
    expect(JSON.parse((await buildSiteSnapshot()).files.avis).avis).toEqual([]);
    await prisma.siteReview.update({ where: { id: row.id }, data: { status: "DRAFT" } });

    // Le client le reprend : de nouveau à valider, puis publié tel quel.
    await put(cookie, project.id, { ...testimonial, text: "Version sans coordonnées." });
    expect(await prisma.siteReview.findFirstOrThrow()).toMatchObject({ rejectedAt: null, status: "DRAFT" });
    expect((await adminCall("POST", `/api/site/reviews/${row.id}/publish`)).statusCode).toBe(200);
    const avis = JSON.parse((await buildSiteSnapshot()).files.avis).avis;
    expect(avis).toEqual([expect.objectContaining({ auteur: "Marie D.", texte: "Version sans coordonnées." })]);
  });

  it("saisie manuelle : preuve d'accord obligatoire pour publier", async () => {
    const client = await createClient({ displayName: "Paul Martin" });
    const base = { author: "Paul M.", reviewedOn: "2026-10-01", text: "Merci.", clientId: client.id, experienceOn: "2026-09-20", consentAt: "2026-10-02T10:00:00Z", status: "PUBLISHED" };
    expect((await adminCall("POST", "/api/site/reviews", base)).json().error).toMatch(/Preuve de l'accord requise/);
    expect((await adminCall("POST", "/api/site/reviews", { ...base, consentProof: "E-mail du 2 octobre : « d'accord pour publier »." })).statusCode).toBe(201);
  });

  it("purge : IP et navigateur retirés 3 ans après le retrait, date et version gardées", async () => {
    const { project, cookie } = await portalClient();
    await put(cookie, project.id);
    const old = new Date(Date.now() - PROOF_RETENTION_MS - 86_400_000);
    await prisma.siteReview.updateMany({ data: { status: "WITHDRAWN", publishedAt: old, withdrawalRequestedAt: old } });
    expect(await purgeTestimonialProofs()).toBe(1);
    const proof = JSON.parse(decrypt((await prisma.siteReview.findFirstOrThrow()).consentProofEncrypted!));
    expect(proof).not.toHaveProperty("ip");
    expect(proof).not.toHaveProperty("userAgent");
    expect(proof).toMatchObject({ consentVersion: CONSENT_VERSION });
    expect(await purgeTestimonialProofs()).toBe(0);
  });
});
