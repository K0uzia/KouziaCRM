import fs from "node:fs/promises";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// SMTP « configuré » mais aucun envoi réseau : les e-mails restent dans la file, on y lit les codes.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");
const { checkPortalCode, issuePortalCode, maskEmail, purgePortalData, CODE_MAX_PER_HOUR } = await import(
  "@/lib/portal/auth.js"
);
const { issueQuote } = await import("@/lib/invoices/transitions.js");

const EMAIL = "camille@exemple.fr";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
});

afterEach(async () => {
  await resetDb();
});

async function clientWithEmail() {
  const client = await createClient({ displayName: "Camille Dupont", type: "B2C" });
  await prisma.client.update({
    where: { id: client.id },
    data: {
      firstName: "Camille",
      lastName: "Dupont",
      emailEncrypted: encrypt(EMAIL),
      emailHash: computeEmailHash(EMAIL),
    },
  });
  return client;
}

/** Dernier code envoyé : 6 chiffres en tête du sujet de l'e-mail. */
async function lastSentCode(): Promise<string> {
  const row = await prisma.emailOutbox.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  const code = parsePayload(outboxPayloadRaw(row)).subject.match(/^(\d{6}) /)?.[1];
  if (!code) throw new Error("Aucun code dans le dernier e-mail");
  return code;
}

/** L'envoi du code de connexion part hors du temps de réponse : on l'attend. */
async function waitForOutbox(count: number) {
  for (let i = 0; i < 50 && (await prisma.emailOutbox.count()) < count; i++) {
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

function cookiesOf(res: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

async function login(device?: string) {
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  await waitForOutbox((await prisma.emailOutbox.count()) + 1);
  const code = await lastSentCode();
  return app.inject({
    method: "POST",
    url: "/api/public/auth/verify",
    payload: { email: EMAIL, code },
    cookies: device ? { kz_device: device } : {},
  });
}

describe("codes du portail", () => {
  it("un code ne sert qu'une fois", async () => {
    const client = await clientWithEmail();
    const code = (await issuePortalCode(client.id, "LOGIN"))!;
    expect(code).toMatch(/^\d{6}$/);
    expect(await checkPortalCode(client.id, "LOGIN", code)).toBe("ok");
    expect(await checkPortalCode(client.id, "LOGIN", code)).toBe("invalid");
  });

  it("bloque le code après 5 essais faux, même si le bon arrive ensuite", async () => {
    const client = await clientWithEmail();
    const code = (await issuePortalCode(client.id, "LOGIN"))!;
    const faux = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      expect(await checkPortalCode(client.id, "LOGIN", faux)).toBe("invalid");
    }
    expect(await checkPortalCode(client.id, "LOGIN", faux)).toBe("locked");
    expect(await checkPortalCode(client.id, "LOGIN", code)).toBe("locked");
  });

  it("un nouveau code annule le précédent", async () => {
    const client = await clientWithEmail();
    const ancien = (await issuePortalCode(client.id, "LOGIN"))!;
    const nouveau = (await issuePortalCode(client.id, "LOGIN"))!;
    if (ancien !== nouveau) {
      expect(await checkPortalCode(client.id, "LOGIN", ancien)).toBe("invalid");
    }
    expect(await checkPortalCode(client.id, "LOGIN", nouveau)).toBe("ok");
  });

  it("limite le nombre de codes par heure", async () => {
    const client = await clientWithEmail();
    for (let i = 0; i < CODE_MAX_PER_HOUR; i++) {
      expect(await issuePortalCode(client.id, "LOGIN")).not.toBeNull();
    }
    expect(await issuePortalCode(client.id, "LOGIN")).toBeNull();
  });

  it("masque l'adresse", () => {
    expect(maskEmail("camille@exemple.fr")).toBe("c***@exemple.fr");
  });

  it("purge les vieux codes et les sessions terminées depuis plus d'un an", async () => {
    const client = await clientWithEmail();
    const jours = (n: number) => new Date(Date.now() + n * 86_400_000);
    await prisma.portalCode.createMany({
      data: [
        { clientId: client.id, purpose: "LOGIN", codeHash: "a", expiresAt: jours(-2) },
        { clientId: client.id, purpose: "LOGIN", codeHash: "b", expiresAt: jours(1) },
      ],
    });
    await prisma.portalSession.createMany({
      data: [
        { clientId: client.id, tokenHash: "t1", deviceHash: "d", expiresAt: jours(-400) },
        { clientId: client.id, tokenHash: "t2", deviceHash: "d", expiresAt: jours(-10) },
      ],
    });
    expect(await purgePortalData()).toEqual({ codes: 1, sessions: 1 });
    expect(await prisma.portalSession.findMany({ select: { tokenHash: true } })).toEqual([{ tokenHash: "t2" }]);
  });
});

describe("connexion à l'espace client", () => {
  it("répond pareil pour une adresse inconnue, sans rien envoyer", async () => {
    await clientWithEmail();
    const res = await app.inject({
      method: "POST",
      url: "/api/public/auth/code",
      payload: { email: "inconnu@exemple.fr" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await new Promise((ok) => setTimeout(ok, 100));
    expect(await prisma.emailOutbox.count()).toBe(0);
  });

  it("refuse un mauvais code, ouvre une session avec le bon et confirme l'adresse", async () => {
    const client = await clientWithEmail();
    await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
    await waitForOutbox(1);
    const code = await lastSentCode();

    const faux = await app.inject({
      method: "POST",
      url: "/api/public/auth/verify",
      payload: { email: EMAIL, code: code === "000000" ? "111111" : "000000" },
    });
    expect(faux.statusCode).toBe(401);

    const bon = await app.inject({
      method: "POST",
      url: "/api/public/auth/verify",
      payload: { email: EMAIL, code },
    });
    expect(bon.statusCode).toBe(200);
    const session = bon.cookies.find((c) => c.name === "kz_portal");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
    expect(session?.path).toBe("/api/public");

    const suivi = await app.inject({
      method: "GET",
      url: "/api/public/tracking",
      cookies: { kz_portal: session!.value },
    });
    expect(suivi.statusCode).toBe(200);
    expect(suivi.json()).toMatchObject({
      clientFirstName: "Camille",
      emailMasked: "c***@exemple.fr",
      signer: { firstName: "Camille", lastName: "Dupont", companyName: null },
    });

    const fiche = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(fiche.emailVerifiedAt).toBeTruthy();
  });

  it("sans session, l'espace et la déconnexion ferment l'accès", async () => {
    await clientWithEmail();
    expect((await app.inject({ method: "GET", url: "/api/public/tracking" })).statusCode).toBe(401);

    const { kz_portal } = cookiesOf(await login());
    await app.inject({
      method: "POST",
      url: "/api/public/auth/logout",
      cookies: { kz_portal },
    });
    const apres = await app.inject({
      method: "GET",
      url: "/api/public/tracking",
      cookies: { kz_portal },
    });
    expect(apres.statusCode).toBe(401);
  });

  it("alerte par e-mail seulement pour un nouvel appareil", async () => {
    await clientWithEmail();
    const alertes = async () =>
      (await prisma.emailOutbox.findMany()).filter((r) =>
        parsePayload(outboxPayloadRaw(r)).subject.startsWith("Nouvelle connexion"),
      ).length;

    const premiere = await login();
    const { kz_device } = cookiesOf(premiere);
    expect(kz_device).toBeTruthy();
    await login(kz_device);
    await new Promise((ok) => setTimeout(ok, 100));
    expect(await alertes()).toBe(0);

    await login();
    await waitForOutbox((await prisma.emailOutbox.count()) + 1);
    expect(await alertes()).toBe(1);
  });
});

describe("signature d'un devis depuis l'espace client", () => {
  async function devisEnvoye(clientId: string) {
    const quote = await prisma.invoice.create({
      data: {
        clientId,
        documentType: InvoiceDocumentType.QUOTE,
        status: InvoiceStatus.DRAFT,
        subtotalCents: 100000,
        totalCents: 100000,
        lines: {
          create: [
            { position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 100000, lineTotalCents: 100000 },
          ],
        },
      },
    });
    await issueQuote(quote.id, new Date());
    return quote.id;
  }

  it("exige le code de ce devis, puis enregistre la signature", async () => {
    const client = await clientWithEmail();
    const quoteId = await devisEnvoye(client.id);
    const { kz_portal } = cookiesOf(await login());
    const corps = { decision: "ACCEPT", firstName: "Camille", lastName: "dupont", signatureMode: "TYPED" };

    const sansCode = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/decision`,
      cookies: { kz_portal },
      payload: { ...corps, code: "123456" },
    });
    expect(sansCode.statusCode).toBe(401);

    const envoi = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/sign-code`,
      cookies: { kz_portal },
    });
    expect(envoi.statusCode).toBe(200);
    expect(envoi.json()).toEqual({ emailMasked: "c***@exemple.fr" });

    const signe = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/decision`,
      cookies: { kz_portal },
      payload: { ...corps, code: await lastSentCode() },
    });
    expect(signe.statusCode).toBe(200);
    expect(signe.json()).toEqual({ quoteStatus: "ACCEPTED" });

    const devis = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    expect(devis.quoteSignerName).toBe("Camille DUPONT");
    const audit = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId } });
    expect(audit).toMatchObject({ signatureMode: "TYPED", verifiedEmailMasked: "c***@exemple.fr" });

    const { signedQuoteAbsolutePath } = await import("@/lib/invoices/acceptance-proof.js");
    for (const p of [audit.pdfPath, audit.originalPdfPath]) {
      if (p) await fs.rm(signedQuoteAbsolutePath(p), { force: true });
    }
  });

  it("refuse la signature d'un devis d'un autre client", async () => {
    await clientWithEmail();
    const autre = await createClient({ displayName: "Autre" });
    const quoteId = await devisEnvoye(autre.id);
    const { kz_portal } = cookiesOf(await login());
    const res = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/sign-code`,
      cookies: { kz_portal },
    });
    expect(res.statusCode).toBe(404);
  });
});
