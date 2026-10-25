import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Lot B (audit de sécurité du portail du 25/10/2026) : chaque test reproduit un défaut relevé avant sa correction.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));
// Aucun appel réseau (base nationale d'adresses) : l'adresse des fiches modifiées ne change pas.
vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));

const { buildApp } = await import("@/app.js");
const { issuePortalCode, checkPortalCode, CODE_MAX_ATTEMPTS, CODE_MAX_PER_HOUR } = await import("@/lib/portal/auth.js");
const { acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
const { verifyDocumentToken } = await import("@/lib/documents/public-token.js");
const { logClientEmailEvent } = await import("@/lib/email/log-event.js");

const EMAIL = "lou@exemple.fr";
let app: FastifyInstance;

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars!!";
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  await seedCompanySettings();
});

const ADRESSE = { addressLine1: "3 chemin de Recette", addressLine2: "Bât. R", postalCode: "33880", city: "Saint-Caprais-De-Bordeaux", country: "FRANCE" };

async function portalClient() {
  return prisma.client.create({
    data: { displayName: "Lou Martin", type: "B2C", firstName: "Lou", lastName: "Martin", ...ADRESSE, emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
}

const latestCode = (clientId: string) => prisma.portalCode.findFirstOrThrow({ where: { clientId }, orderBy: { createdAt: "desc" } });
const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

describe("P1 : essais et consommation du code atomiques", () => {
  it("vérifications parallèles avec un mauvais code : chacune compte pour un essai", async () => {
    const client = await portalClient();
    const code = (await issuePortalCode(client.id, "LOGIN"))!;
    const results = await Promise.all(Array.from({ length: 4 }, () => checkPortalCode(client.id, "LOGIN", wrong(code))));
    expect(results.every((r) => r !== "ok")).toBe(true);
    expect((await latestCode(client.id)).attempts).toBe(4);
  });

  it("rafale au-delà du plafond : jamais plus de 5 essais, le bon code est ensuite refusé", async () => {
    const client = await portalClient();
    const code = (await issuePortalCode(client.id, "LOGIN"))!;
    await Promise.all(Array.from({ length: 12 }, () => checkPortalCode(client.id, "LOGIN", wrong(code))));
    expect((await latestCode(client.id)).attempts).toBe(CODE_MAX_ATTEMPTS);
    expect(await checkPortalCode(client.id, "LOGIN", code)).not.toBe("ok");
  });

  it("bon code présenté deux fois en parallèle : un seul « ok »", async () => {
    const client = await portalClient();
    const code = (await issuePortalCode(client.id, "SIGN", null))!;
    const results = await Promise.all([checkPortalCode(client.id, "SIGN", code), checkPortalCode(client.id, "SIGN", code), checkPortalCode(client.id, "SIGN", code)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("codes demandés en rafale : jamais plus de 5 par heure", async () => {
    const client = await portalClient();
    const codes = await Promise.all(Array.from({ length: 12 }, () => issuePortalCode(client.id, "LOGIN")));
    expect(codes.filter(Boolean).length).toBeLessThanOrEqual(CODE_MAX_PER_HOUR);
    expect(await prisma.portalCode.count({ where: { clientId: client.id } })).toBeLessThanOrEqual(CODE_MAX_PER_HOUR);
  });

  it("limite de débit par préfixe IPv6 /64 sur la demande de code", async () => {
    const send = (ip: string) => app.inject({ method: "POST", url: "/api/public/auth/code", remoteAddress: ip, payload: { email: "personne@exemple.fr" } });
    for (let i = 1; i <= 10; i++) expect((await send(`2001:db8:1:2::${i.toString(16)}`)).statusCode).toBe(200);
    expect((await send("2001:db8:1:2:ffff::1")).statusCode).toBe(429);
    expect((await send("2001:db8:1:3::1")).statusCode).toBe(200);
  });
});

describe("clé des limites de débit", () => {
  it("IPv6 réduite à son /64 quelle que soit l'écriture ; IPv4 et IPv4 mappée inchangées", async () => {
    const { rateLimitKey } = await import("@/lib/client-ip.js");
    expect(rateLimitKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:0db8:0001:0002:abcd:ef01:2345:6789")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("P2 : réponses et jetons", () => {
  it("code verrouillé : même réponse qu'une adresse inconnue (aucune énumération des clients)", async () => {
    const client = await portalClient();
    const code = (await issuePortalCode(client.id, "LOGIN"))!;
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
      await app.inject({ method: "POST", url: "/api/public/auth/verify", remoteAddress: "198.51.100.7", payload: { email: EMAIL, code: wrong(code) } });
    }
    const locked = await app.inject({ method: "POST", url: "/api/public/auth/verify", remoteAddress: "198.51.100.7", payload: { email: EMAIL, code: wrong(code) } });
    const unknown = await app.inject({ method: "POST", url: "/api/public/auth/verify", remoteAddress: "198.51.100.8", payload: { email: "inconnu@exemple.fr", code: "123456" } });
    expect(locked.statusCode).toBe(unknown.statusCode);
    expect(locked.json()).toEqual(unknown.json());
  });

  it("devis dont la validité est dépassée : signature refusée (portail et réponse par e-mail), pas pour une signature saisie par l'administrateur", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.SENT, number: "D-2026-0200",
        clientId: client.id, subtotalCents: 50000, totalCents: 50000, issueDate: new Date(), validUntil: new Date(Date.now() - 86_400_000),
        lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 50000, lineTotalCents: 50000 }] },
      },
    });
    await expect(acceptQuoteByClient(quote.id, "Lou Martin", { source: "PORTAL" })).rejects.toMatchObject({ code: "EXPIRED" });
    await expect(acceptQuoteByClient(quote.id, "Lou Martin", { source: "THREAD" })).rejects.toMatchObject({ code: "EXPIRED" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: quote.id } })).quoteStatus).toBe(QuoteStatus.SENT);
    await expect(acceptQuoteByClient(quote.id, "Lou Martin", { source: "ADMIN" })).resolves.toMatchObject({ quoteStatus: QuoteStatus.ACCEPTED });
  });

  it("preuve de signature dans la transaction : son échec laisse le devis en attente", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.SENT, number: "D-2026-0201",
        clientId: client.id, subtotalCents: 50000, totalCents: 50000, issueDate: new Date(),
        lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 50000, lineTotalCents: 50000 }] },
      },
    });
    const failing = { create: async () => { throw new Error("écriture de la preuve impossible"); } };
    // Échec simulé de l'écriture de la preuve, où qu'elle soit faite (dans la transaction ou après).
    vi.spyOn(prisma.quoteAcceptanceAudit, "create").mockImplementation((() => failing.create()) as never);
    const realTransaction = prisma.$transaction.bind(prisma) as (fn: unknown, opts?: unknown) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opts?: unknown) =>
      typeof fn === "function"
        ? realTransaction(
            (tx: Record<string | symbol, unknown>) =>
              (fn as (t: unknown) => unknown)(new Proxy(tx, { get: (t, k) => (k === "quoteAcceptanceAudit" ? failing : t[k]) })),
            opts,
          )
        : realTransaction(fn, opts)) as never);
    await expect(acceptQuoteByClient(quote.id, "Lou Martin", { source: "ADMIN" })).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: quote.id } })).quoteStatus).toBe(QuoteStatus.SENT);
    expect(await prisma.quoteAcceptanceAudit.count({ where: { quoteId: quote.id } })).toBe(0);
  });

  it("ancien format de jeton de document (sans date d'expiration) : refusé", () => {
    const body = Buffer.from("facture-ancienne", "utf8").toString("base64url");
    const sig = createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url");
    expect(verifyDocumentToken(`${body}.${sig}`)).toBeNull();
  });

  it("code de connexion masqué dans le journal des e-mails du client", async () => {
    const client = await createClient();
    await logClientEmailEvent({ clientId: client.id, kind: "portal_code", subject: "482913 : votre code de connexion Test", toAddress: EMAIL });
    const row = await prisma.clientEmailEvent.findFirstOrThrow({ where: { clientId: client.id } });
    expect(row.subject).not.toContain("482913");
  });

  it("adresse e-mail principale changée : toutes les sessions du portail sont révoquées", async () => {
    const client = await portalClient();
    await prisma.portalSession.create({ data: { clientId: client.id, tokenHash: "a".repeat(64), deviceHash: "b".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) } });
    const user = await prisma.user.upsert({ where: { email: "admin-b@kouzia.test" }, update: {}, create: { email: "admin-b@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") } });
    const cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
    const form = {
      type: "B2C", firstName: "Lou", lastName: "Martin", companyName: "", email: "nouvelle@exemple.fr", phone: null, siret: null, siren: null, apeCode: null,
      companyVerifiedAt: null, ...ADRESSE, addressCityCode: null, addressLat: null, addressLon: null, addressManualConfirmed: false, notes: "", billingDay: null,
    };
    const res = await app.inject({ method: "PUT", url: `/api/clients/${client.id}`, headers: { cookie }, payload: form });
    expect(res.statusCode).toBe(200);
    expect(await prisma.portalSession.count({ where: { clientId: client.id, revokedAt: null } })).toBe(0);
  });
});
