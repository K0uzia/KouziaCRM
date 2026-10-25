import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { getCompanySettings } from "@/lib/company.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { templateDefinition } from "@/lib/email/template-registry.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Modèles M3c (accès, invitation, renouvellement chez un tiers) : le modèle d'origine enregistré rend exactement l'e-mail
// du code ; aperçu sur donnée réelle : valeurs calculées comme à l'envoi, rien n'est envoyé ni enregistré.
const sendEmail = vi.fn(async () => undefined);
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail,
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));

const { portalWelcomeDraft } = await import("@/lib/clients/access-email.js");
const { onboardingInviteDraft } = await import("@/lib/clients/onboarding.js");
const { renderClientRenewalEmail } = await import("@/lib/clients/renewals.js");
const { buildEmailBrand } = await import("@/lib/email/deposit-templates.js");
const { requestSubscriptionCancellation } = await import("@/lib/subscriptions/self-service.js");
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-m3c@kouzia.test";
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
  sendEmail.mockClear();
});

async function original(key: string) {
  const def = templateDefinition(key)!;
  await prisma.emailTemplate.deleteMany({ where: { key } });
  await prisma.emailTemplate.create({ data: { key, subject: def.subject, body: def.body } });
}

async function same<T>(key: string, render: () => Promise<T>) {
  await prisma.emailTemplate.deleteMany({ where: { key } });
  const fromCode = await render();
  await original(key);
  expect(await render()).toEqual(fromCode);
}

async function client(firstName: string | null = "Lou") {
  const c = await createClient({ displayName: "Lou Martin" });
  return prisma.client.update({ where: { id: c.id }, data: { firstName, emailEncrypted: encrypt("lou@example.com") } });
}

describe("M3c : modèle d'origine enregistré = e-mail du code", () => {
  it.each([["avec prénom", "Lou"], ["sans prénom", null]])("accès à l'espace client (%s)", async (_l, first) => {
    const c = await client(first);
    await same("access.welcome", () => portalWelcomeDraft(c.id));
  });

  it("invitation : nouveau client et mise à jour d'une fiche", async () => {
    const c = await client();
    await same("onboarding.invite", () => onboardingInviteDraft("lou@example.com", null));
    await same("onboarding.invite", () => onboardingInviteDraft("lou@example.com", c.id));
  });

  it.each([["chez un hébergeur nommé", "Hostinger"], ["sans hébergeur", null]])("renouvellement chez un tiers (%s)", async (_l, provider) => {
    const settings = await getCompanySettings();
    await same("client.renewal", () =>
      renderClientRenewalEmail({
        brand: buildEmailBrand(settings),
        settings,
        clientName: "Lou Martin",
        clientFirstName: "Lou",
        renewal: { label: "Hébergement et domaine", provider, renewsAt: new Date(2026, 11, 1) },
      }),
    );
  });

  it("modèle modifié : le lien et la façon de se connecter restent ceux du système", async () => {
    const c = await client();
    await prisma.emailTemplate.create({ data: { key: "access.welcome", subject: "Bienvenue chez {{marque}}", body: "{{salutation}}\n\nUn mot personnel.\n\n{{lien}}\n{{bloc_connexion}}" } });
    const draft = (await portalWelcomeDraft(c.id))!;
    expect(draft.text).toContain("Un mot personnel.");
    expect(draft.text).toContain("Saisissez votre adresse e-mail (lou@example.com)");
    expect(draft.text).toMatch(/\nhttps?:\/\/\S+\n/);
  });
});

describe("M3c : aperçu sur donnée réelle", () => {
  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: ADMIN } });
    await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
    cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
  });
  const call = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  async function subscription(extra: Record<string, unknown> = {}) {
    const c = await client();
    const service = await createService({ name: "Maintenance", isSubscription: true });
    return prisma.subscription.create({
      data: { clientId: c.id, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(), nextInvoiceAt: new Date(Date.now() + 20 * 86_400_000), ...extra },
    });
  }

  it("réservé à l'administrateur", async () => {
    expect((await app.inject({ method: "GET", url: "/api/email-templates/subscription.cancel_request/sources" })).statusCode).toBe(401);
  });

  it("liste les dernières données du type ; aucune pour un modèle verrouillé", async () => {
    const sub = await subscription();
    const res = await call("GET", "/api/email-templates/subscription.cancel_request/sources");
    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual([{ id: sub.id, label: "Maintenance - Lou Martin" }]);
    expect((await call("GET", "/api/email-templates/access.login_code/sources")).json().sources).toEqual([]);
    expect((await call("GET", "/api/email-templates/onboarding.invite/sources")).json().sources[0]).toEqual({ id: "nouveau", label: "Nouveau client" });
  });

  it("le texte saisi sur la donnée choisie, tel qu'à l'envoi ; rien n'est envoyé ni enregistré", async () => {
    const sub = await subscription({ commitmentMonths: 12, commitmentEndsAt: new Date(Date.now() + 200 * 86_400_000) });
    const draft = { subject: "Résiliation : {{abonnement}}", body: "{{salutation}}\n\nBien noté, le {{date_demande}}.\n\n{{bloc_fin}}\n\n{{bloc_accuse}}" };
    const res = await call("POST", "/api/email-templates/subscription.cancel_request/preview", { ...draft, sourceId: sub.id });
    expect(res.statusCode).toBe(200);
    const preview = res.json() as { subject: string; text: string; html: string; templateIssues: unknown[] };
    expect(preview.subject).toBe("Résiliation : Maintenance");
    expect(preview.text).toMatch(/^Bonjour Lou,\n\nBien noté, le .+\.\n\nVotre abonnement prendra fin le /);
    expect(preview.html).toContain("Bien noté, le ");
    expect(preview.templateIssues).toEqual([]);
    expect(await prisma.emailOutbox.count()).toBe(0);
    expect(await prisma.emailTemplate.count()).toBe(0);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).cancellationRequestedAt).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();

    // Même modèle enregistré puis envoi réel : l'e-mail parti est celui de l'aperçu.
    await prisma.emailTemplate.create({ data: { key: "subscription.cancel_request", ...draft } });
    await requestSubscriptionCancellation(sub.id);
    const sent = parsePayload(outboxPayloadRaw((await prisma.emailOutbox.findFirstOrThrow())));
    expect({ subject: sent.subject, text: sent.text, html: sent.html }).toEqual({ subject: preview.subject, text: preview.text, html: preview.html });
  });

  it("renouvellement chez un tiers et invitation sur donnée réelle", async () => {
    const c = await client();
    const renewal = await prisma.clientRenewal.create({ data: { clientId: c.id, label: "Hébergement et domaine", provider: "Hostinger", renewsAt: new Date(2026, 11, 1) } });
    const def = templateDefinition("client.renewal")!;
    const r = await call("POST", "/api/email-templates/client.renewal/preview", { subject: def.subject, body: def.body, sourceId: renewal.id });
    expect(r.json().text).toContain("« Hébergement et domaine » est à votre nom chez Hostinger");
    const inv = templateDefinition("onboarding.invite")!;
    const i = await call("POST", "/api/email-templates/onboarding.invite/preview", { subject: inv.subject, body: inv.body, sourceId: c.id });
    expect(i.json().subject).toMatch(/^Mise à jour de votre fiche client - /);
    expect(await prisma.emailOutbox.count()).toBe(0);
  });

  it("donnée inconnue ou d'un autre type : 404", async () => {
    const sub = await subscription();
    const def = templateDefinition("client.renewal")!;
    expect((await call("POST", "/api/email-templates/client.renewal/preview", { subject: def.subject, body: def.body, sourceId: sub.id })).statusCode).toBe(404);
    expect((await call("POST", "/api/email-templates/client.renewal/preview", { subject: def.subject, body: def.body, sourceId: "inconnu" })).statusCode).toBe(404);
  });
});
