import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-reglages@kouzia.test";
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

const patch = (payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: "/api/settings/general", headers: { cookie }, payload });

describe("Réglages > Identité : erreurs par champ", () => {
  it("refuse les valeurs invalides avec un message en français par champ, sans rien enregistrer", async () => {
    const res = await patch({
      siren: "12345",
      email: "pas-une-adresse",
      googleReviewUrl: "http://exemple.fr/avis",
      clientPortalUrl: "exemple.fr",
      legalName: "  ",
    });
    expect(res.statusCode).toBe(400);
    const fields = res.json().error.fieldErrors as Record<string, string[]>;
    expect(fields.siren?.[0]).toBe("Le SIREN compte 9 chiffres");
    expect(fields.email?.[0]).toBe("Adresse e-mail invalide");
    expect(fields.googleReviewUrl?.[0]).toBe("Le lien d'avis doit être une adresse https:// complète");
    expect(fields.clientPortalUrl?.[0]).toBe("Adresse web complète attendue (https://…)");
    expect(fields.legalName?.[0]).toBe("Nom légal : champ obligatoire");
    const settings = await prisma.companySettings.findFirstOrThrow();
    expect(settings.siren).toBe("000000000");
  });

  it("champs facultatifs vides acceptés et enregistrés vides", async () => {
    const res = await patch({ email: "", googleReviewUrl: "", clientPortalUrl: "" });
    expect(res.statusCode).toBe(200);
    const settings = await prisma.companySettings.findFirstOrThrow();
    expect(settings).toMatchObject({ email: null, googleReviewUrl: null, clientPortalUrl: null });
  });
});
