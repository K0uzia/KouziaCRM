import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { emailAttachmentsRoot } from "@/lib/email/attachments.js";
import { contentDisposition } from "@/lib/http.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : le Content-Disposition reprenait le nom brut d'une pièce jointe reçue ; un caractère hors
// latin-1 (apostrophe typographique, emoji) faisait refuser l'en-tête par Node : erreur 500, pièce jointe illisible.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-pj@kouzia.test";
const FILE = "audit-pj-unicode.bin";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  app = await buildApp({ silent: true, serveStatic: false });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
  mkdirSync(emailAttachmentsRoot(), { recursive: true });
  writeFileSync(path.join(emailAttachmentsRoot(), FILE), "contenu");
});
afterAll(async () => {
  rmSync(path.join(emailAttachmentsRoot(), FILE), { force: true });
  await app.close();
  await resetDb();
});

describe("pièce jointe au nom hors latin-1", () => {
  it("téléchargement : 200, nom exact en UTF-8 et repli ASCII", async () => {
    const thread = await prisma.emailThread.create({ data: { subject: "Devis", participants: "[]", lastMessageAt: new Date() } });
    const message = await prisma.emailMessage.create({
      data: { threadId: thread.id, direction: "INBOUND", messageId: "<pj-unicode@test>", fromAddress: "a@b.c", toAddresses: "[]", subject: "Devis", receivedAt: new Date() },
    });
    const name = "Devis d’Alexandre ✅.pdf";
    const att = await prisma.emailAttachment.create({ data: { messageId: message.id, filename: name, mimeType: "application/pdf", sizeBytes: 7, storagePath: `email-attachments/${FILE}` } });
    const res = await app.inject({ method: "GET", url: `/api/emails/attachments/${att.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, "%27")}`);
  });

  it("en-tête : guillemets, retours à la ligne et antislash neutralisés", () => {
    expect(contentDisposition("attachment", 'a"b\r\nc\\d.pdf')).toBe(`attachment; filename="a_b__c_d.pdf"; filename*=UTF-8''a_b__c_d.pdf`);
  });
});
