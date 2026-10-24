import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { buildApp } from "@/app.js";
import { templateDefinition } from "@/lib/email/template-registry.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Modèles d'e-mails (M2) : liste, lecture, enregistrement contrôlé, retour au texte d'origine, aperçu.
const ADMIN = "admin-modeles@kouzia.test";
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
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const invoice = templateDefinition("document.invoice")!;

describe("modèles d'e-mails", () => {
  it("réservé à l'administrateur", async () => {
    expect((await app.inject({ method: "GET", url: "/api/email-templates" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/email-templates/document.invoice", payload: { subject: "x {{numero}}", body: "y" } })).statusCode).toBe(401);
  });

  it("liste : chaque modèle du registre, mise en demeure verrouillée, aucun modifié au départ", async () => {
    const res = await call("GET", "/api/email-templates");
    expect(res.statusCode).toBe(200);
    const list = res.json().templates as Array<{ key: string; locked: string | null; modified: boolean }>;
    expect(list.map((t) => t.key)).toContain("document.quote");
    expect(list.find((t) => t.key === "reminder.formal")?.locked).toBeTruthy();
    expect(list.every((t) => !t.modified)).toBe(true);
  });

  it("enregistre une modification, la relit, puis revient au texte d'origine (ligne supprimée)", async () => {
    const put = await call("PUT", "/api/email-templates/document.invoice", { subject: "Votre facture {{numero}}", body: "{{salutation}}\r\n\r\nFacture {{numero}} jointe." });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ modified: true, current: { subject: "Votre facture {{numero}}", body: "{{salutation}}\n\nFacture {{numero}} jointe." } });
    expect((await call("GET", "/api/email-templates")).json().templates.find((t: { key: string }) => t.key === "document.invoice").modified).toBe(true);

    const reset = await call("DELETE", "/api/email-templates/document.invoice");
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ modified: false, current: { subject: invoice.subject, body: invoice.body } });
    expect(await prisma.emailTemplate.count()).toBe(0);
  });

  it("enregistrer le texte d'origine ne garde aucune ligne", async () => {
    await prisma.emailTemplate.create({ data: { key: "document.invoice", subject: "Autre {{numero}}", body: "{{numero}}" } });
    const res = await call("PUT", "/api/email-templates/document.invoice", { subject: invoice.subject, body: invoice.body });
    expect(res.json().modified).toBe(false);
    expect(await prisma.emailTemplate.count()).toBe(0);
  });

  it("refuse une variable inconnue ou une variable obligatoire retirée (400, détail par champ), rien n'est écrit", async () => {
    const unknown = await call("PUT", "/api/email-templates/document.invoice", { subject: "Facture {{numero}}", body: "{{montant}}" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().templateIssues).toEqual([expect.objectContaining({ field: "body", code: "unknown_variable", variable: "montant" })]);
    const missing = await call("PUT", "/api/email-templates/document.invoice", { subject: "Facture", body: "{{salutation}}" });
    expect(missing.json().templateIssues.map((i: { code: string }) => i.code)).toEqual(["missing_required"]);
    expect(await prisma.emailTemplate.count()).toBe(0);
  });

  it("mise en demeure : lecture seule, modification et retour refusés en 409", async () => {
    expect((await call("GET", "/api/email-templates/reminder.formal")).json()).toMatchObject({ locked: expect.any(String), modified: false });
    expect((await call("PUT", "/api/email-templates/reminder.formal", { subject: "x {{numero}}", body: "{{numero}}" })).statusCode).toBe(409);
    expect((await call("DELETE", "/api/email-templates/reminder.formal")).statusCode).toBe(409);
    expect(await prisma.emailTemplate.count()).toBe(0);
  });

  it("modèle inconnu : 404 ; champ en trop : 400", async () => {
    expect((await call("GET", "/api/email-templates/inconnu")).statusCode).toBe(404);
    expect((await call("PUT", "/api/email-templates/document.invoice", { subject: "a {{numero}}", body: "b", extra: 1 })).statusCode).toBe(400);
  });

  it("aperçu : données d'exemple, signature, HTML échappé, problèmes signalés sans rien enregistrer", async () => {
    const res = await call("POST", "/api/email-templates/document.invoice/preview", { subject: "Facture {{numero}}", body: "{{salutation}}\n\n<b>{{numero}}</b>\n\nRégler en ligne : {{lien_paiement}}\n{{inconnue}}" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subject).toBe("Facture F-2026-0042");
    expect(body.text.startsWith("Bonjour Lou,\n\n<b>F-2026-0042</b>\n\nRégler en ligne : https://")).toBe(true);
    expect(body.html).toContain("&lt;b&gt;F-2026-0042&lt;/b&gt;");
    expect(body.templateIssues.map((i: { code: string }) => i.code)).toEqual(["unknown_variable"]);
    expect(await prisma.emailTemplate.count()).toBe(0);
  });
});
