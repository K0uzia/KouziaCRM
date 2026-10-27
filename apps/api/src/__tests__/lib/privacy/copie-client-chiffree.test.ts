import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { backfillEncryptedEmails } from "@/lib/privacy/at-rest.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { pdfText } from "../../helpers/pdf-text.js";

// Décision d'Alexandre du 27/10/2026 : la copie du client figée dans chaque document émis (e-mail, téléphone, SIRET)
// était en clair dans Invoice.clientSnapshot. Elle est chiffrée au repos ; les documents existants sont recopiés
// chiffrés par le worker, puis l'ancienne colonne est vidée, sans changer le PDF.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-copie-client@kouzia.test";
const EMAIL = "lea.martin@exemple.fr";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

/**
 * Texte brut des colonnes de la copie du client, en base : ce qu'une copie de la base laisserait lire. La version
 * lisible du PDF (readableSnapshot) reprend aussi ces coordonnées : hors périmètre de cette décision, signalée à part.
 */
async function rawRow(id: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT "clientSnapshot", "clientSnapshotEncrypted" FROM "Invoice" WHERE "id" = ?`, id);
  return JSON.stringify(rows[0]);
}

async function issuedInvoice() {
  const client = await createClient({ displayName: "Léa Martin", type: "B2B" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(EMAIL), phoneEncrypted: encrypt("0611223344") } });
  const inv = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 500 }] })).json();
  expect((await call("POST", `/api/invoices/${inv.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return inv.id as string;
}

describe("copie du client d'un document émis, chiffrée au repos", () => {
  it("émission : ni e-mail ni téléphone en clair dans la ligne, PDF inchangé", async () => {
    const id = await issuedInvoice();
    const raw = await rawRow(id);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain("0611223344");
    const pdf = (await call("GET", `/api/invoices/${id}/pdf`)).rawPayload;
    expect(pdfText(pdf)).toContain("Léa Martin");
  });

  it("document antérieur en clair : recopié chiffré par le worker, ancienne colonne vidée, relecture identique", async () => {
    const id = await issuedInvoice();
    const snapshot = { displayName: "Léa Martin", type: "B2B", email: EMAIL, phone: "0611223344", siret: null, addressLine1: null, addressLine2: null, postalCode: null, city: null, country: "FRANCE" };
    await prisma.invoice.update({ where: { id }, data: { clientSnapshot: snapshot as unknown as Prisma.InputJsonValue, clientSnapshotEncrypted: null } });
    expect(await rawRow(id)).toContain(EMAIL);

    const done = await backfillEncryptedEmails();
    expect(done.clientSnapshots).toBe(1);
    expect(await rawRow(id)).not.toContain(EMAIL);
    const { readClientSnapshot } = await import("@/lib/invoices/client-snapshot.js");
    expect(readClientSnapshot(await prisma.invoice.findUniqueOrThrow({ where: { id } }))).toEqual(snapshot);
    // Rattrapage idempotent : rien de plus au passage suivant.
    expect((await backfillEncryptedEmails()).clientSnapshots).toBe(0);
  });
});
