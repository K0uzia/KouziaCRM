import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";
import { pdfText } from "../helpers/pdf-text.js";

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

const { buildApp } = await import("@/app.js");
const { issueInvoice } = await import("@/lib/invoices/transitions.js");

const ADMIN = "admin-charte@kouzia.test";
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

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Flux de contenu décompressés : opérateurs de couleur (« r g b scn ») lisibles. */
function pdfStreams(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try {
      out.push(inflateSync(pdf.subarray(start, end)).toString("latin1"));
    } catch {
      /* image ou flux non compressé */
    }
    re.lastIndex = end + "endstream".length;
  }
  return out.join("\n");
}

/** #cc3300 → « 0.8 0.2 0 scn » (remplissage) ou « SCN » (trait) : composantes écrites par pdfkit. */
function usesFill(pdf: Buffer, hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => String(Math.round((c / 255) * 1e4) / 1e4));
  const streams = pdfStreams(pdf);
  return [" scn", " rg", " SCN", " RG"].some((op) => streams.includes(`${parts.join(" ")}${op}`));
}

const hasImage = (pdf: Buffer) => /\/Subtype\s*\/Image/.test(pdf.toString("latin1"));

const PRIMARY = "#cc3300";
const SECONDARY = "#003366";

const preview = (payload: Record<string, unknown>, withCookie = true) =>
  app.inject({
    method: "POST",
    url: "/api/settings/identity/preview.pdf",
    headers: withCookie ? { cookie } : {},
    payload: { brandPrimaryColor: PRIMARY, brandSecondaryColor: SECONDARY, ...payload },
  });

async function pngLogo(): Promise<Buffer> {
  return sharp({ create: { width: 160, height: 160, channels: 3, background: "#123456" } }).png().toBuffer();
}

function multipart(file: Buffer, mime: string, filename: string) {
  const boundary = "----charte";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function uploadLogo(file: Buffer, mime = "image/png", filename = "logo.png") {
  const { body, headers } = multipart(file, mime, filename);
  return app.inject({ method: "POST", url: "/api/settings/identity/logo", headers, payload: body });
}

async function dbSnapshot() {
  const [settings, invoices, counters, named, clauses, audits, outbox] = await Promise.all([
    prisma.companySettings.findFirstOrThrow(),
    prisma.invoice.count(),
    prisma.counter.findMany(),
    prisma.namedCounter.findMany(),
    prisma.legalClause.count(),
    prisma.settingsAuditLog.count(),
    prisma.emailOutbox.count(),
  ]);
  return JSON.stringify({ settings, invoices, counters, named, clauses, audits, outbox });
}

describe("Charte des documents : aperçu", () => {
  it("routes d'aperçu et de logo réservées à l'administrateur", async () => {
    expect((await preview({}, false)).statusCode).toBe(401);
    const json = await app.inject({
      method: "POST",
      url: "/api/settings/identity/preview",
      payload: { brandPrimaryColor: PRIMARY, brandSecondaryColor: SECONDARY },
    });
    expect(json.statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/settings/identity/logo" })).statusCode).toBe(401);
  });

  it("rend un PDF marqué EXEMPLE sans rien écrire en base ni attribuer de numéro", async () => {
    const before = await dbSnapshot();
    for (const kind of ["QUOTE", "INVOICE", "CREDIT_NOTE", "RECEIPT"]) {
      const res = await preview({ kind, pdfFooterText: "Merci de votre confiance." });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      const pdf = res.rawPayload;
      expect(pdfText(pdf)).toContain("EXEMPLE");
      expect(pdfText(pdf)).toContain("Merci de votre confiance.");
      expect(usesFill(pdf, PRIMARY)).toBe(true);
      expect(usesFill(pdf, SECONDARY)).toBe(true);
    }
    const json = await app.inject({
      method: "POST",
      url: "/api/settings/identity/preview",
      headers: { cookie },
      payload: { brandPrimaryColor: PRIMARY, brandSecondaryColor: SECONDARY },
    });
    expect(json.statusCode).toBe(200);
    expect(json.json().emailHtml).toContain(PRIMARY);
    expect(json.json().emailHtml).toContain(SECONDARY);
    expect(await dbSnapshot()).toBe(before);
  });

  it("refuse une couleur invalide", async () => {
    expect((await preview({ brandPrimaryColor: "rouge" })).statusCode).toBe(400);
  });

  it("signale les mentions du pied déjà imprimées ailleurs", async () => {
    const settings = await prisma.companySettings.findFirstOrThrow();
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/identity/preview",
      headers: { cookie },
      payload: {
        brandPrimaryColor: PRIMARY,
        brandSecondaryColor: SECONDARY,
        pdfFooterText: `SIRET ${settings.siret}. TVA non applicable, art. 293 B du CGI.`,
      },
    });
    const duplicates = res.json().footerDuplicates as string[];
    expect(duplicates.some((d) => d.includes("SIRET"))).toBe(true);
    expect(duplicates.some((d) => d.includes("TVA"))).toBe(true);
    const clean = await app.inject({
      method: "POST",
      url: "/api/settings/identity/preview",
      headers: { cookie },
      payload: { brandPrimaryColor: PRIMARY, brandSecondaryColor: SECONDARY, pdfFooterText: "Merci de votre confiance." },
    });
    expect(clean.json().footerDuplicates).toEqual([]);
  });

  it("expose les couleurs imprimées : ancienne valeur par défaut remplacée par la charte Kouzia", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
    expect(res.json().brandPrimaryColor).toBe("#0f766e");
    expect(res.json().brand).toMatchObject({ primary: "#fe9a00", secondary: "#0b1020" });
  });
});

describe("Charte des documents : logo", () => {
  it("logo PNG enregistré, imprimé sur l'aperçu, puis supprimé", async () => {
    expect(hasImage((await preview({})).rawPayload)).toBe(false);
    const up = await uploadLogo(await pngLogo());
    expect(up.statusCode).toBe(200);
    expect(up.json().brandLogoPath).toBe("brand/logo.png");
    expect(hasImage((await preview({})).rawPayload)).toBe(true);
    expect(hasImage((await preview({ logo: "none" })).rawPayload)).toBe(false);
    const read = await app.inject({ method: "GET", url: "/api/settings/identity/logo", headers: { cookie } });
    expect(read.statusCode).toBe(200);
    expect(read.headers["content-type"]).toBe("image/png");

    const del = await app.inject({ method: "DELETE", url: "/api/settings/identity/logo", headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect(del.json().brandLogoPath).toBeNull();
    expect(hasImage((await preview({})).rawPayload)).toBe(false);
  });

  it("WebP converti en PNG (seuls PNG et JPEG s'impriment), faux fichier refusé", async () => {
    const webp = await sharp(await pngLogo()).webp().toBuffer();
    const up = await uploadLogo(webp, "image/webp", "logo.webp");
    expect(up.statusCode).toBe(200);
    expect(up.json().brandLogoPath).toBe("brand/logo.png");
    expect(hasImage((await preview({})).rawPayload)).toBe(true);
    const fake = await uploadLogo(Buffer.from("pas une image"), "image/png", "logo.png");
    expect(fake.statusCode).toBe(400);
  });
});

describe("Charte des documents : documents réels", () => {
  async function draftInvoice() {
    const client = await createClient({ type: "B2B", displayName: "Client Charte" });
    return prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: client.id,
        subtotalCents: 50_000,
        totalCents: 50_000,
        lines: { create: { position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 } },
      },
    });
  }

  it("couleurs, logo et pied enregistrés s'appliquent à la facture émise ensuite, puis l'archive reste figée", async () => {
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/settings/identity",
      headers: { cookie },
      payload: { brandPrimaryColor: PRIMARY, brandSecondaryColor: SECONDARY, pdfFooterText: "Pied de la charte." },
    });
    expect(saved.statusCode).toBe(200);
    expect((await uploadLogo(await pngLogo())).statusCode).toBe(200);

    const draft = await draftInvoice();
    await issueInvoice(draft.id, new Date(2026, 9, 1));
    const res = await app.inject({ method: "GET", url: `/api/invoices/${draft.id}/pdf`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const pdf = res.rawPayload;
    expect(usesFill(pdf, PRIMARY)).toBe(true);
    expect(usesFill(pdf, SECONDARY)).toBe(true);
    expect(hasImage(pdf)).toBe(true);
    expect(pdfText(pdf)).toContain("Pied de la charte.");
    expect(pdfText(pdf)).not.toContain("EXEMPLE");

    // Changement de charte après émission : le PDF archivé ne bouge pas.
    await app.inject({
      method: "PATCH",
      url: "/api/settings/identity",
      headers: { cookie },
      payload: { brandPrimaryColor: "#336600", pdfFooterText: "Autre pied." },
    });
    invalidateCompanySettingsCache();
    const again = await app.inject({ method: "GET", url: `/api/invoices/${draft.id}/pdf`, headers: { cookie } });
    expect(sha(again.rawPayload)).toBe(sha(pdf));
  });
});
