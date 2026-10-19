// Bloc-notes unique par client : chiffré au repos, versionné, renvoi sans effet, enregistrement concurrent gardé
// « à relire », anciennes notes visibles avant la reprise, reprise idempotente et à blanc, date de la fiche gardée.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import { notepadTakeover } from "@/lib/reprises/notepad.js";
import { runTakeovers, takeoverSummary } from "@/lib/reprises/index.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-bloc-notes@kouzia.test";
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
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const getPad = (id: string) => app.inject({ method: "GET", url: `/api/clients/${id}/notepad`, headers: { cookie } });
const putPad = (id: string, text: string, baseVersion: number) =>
  app.inject({ method: "PUT", url: `/api/clients/${id}/notepad`, headers: { cookie }, payload: { text, baseVersion } });

/** Fiche avec les anciennes données : « Notes internes » et deux notes de rendez-vous (dans le désordre). */
async function legacyClient() {
  const client = await createClient({ displayName: "Lou Martin", type: "B2C" });
  await prisma.client.update({ where: { id: client.id }, data: { notes: "Préfère être appelée le matin." } });
  await prisma.clientNote.createMany({
    data: [
      { clientId: client.id, bodyEncrypted: encrypt("Second rendez-vous : maquettes validées."), clientRequestId: randomUUID(), preparedAt: new Date("2026-10-12T12:32:00Z") },
      { clientId: client.id, bodyEncrypted: encrypt("Premier rendez-vous : refonte du site."), clientRequestId: randomUUID(), preparedAt: new Date("2026-10-02T07:05:00Z") },
    ],
  });
  return client;
}

const LEGACY_TEXT =
  "Notes internes :\nPréfère être appelée le matin.\n\n02/10/2026 à 09:05 : Premier rendez-vous : refonte du site.\n\n12/10/2026 à 14:32 : Second rendez-vous : maquettes validées.";

describe("bloc-notes : lecture et enregistrement", () => {
  it("avant la reprise, montre les anciennes notes (heure de Paris, ordre chronologique) sans rien écrire", async () => {
    const client = await legacyClient();
    const res = await getPad(client.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: LEGACY_TEXT, version: 0, updatedAt: null, conflictAt: null });
    const row = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(row.notepadEncrypted).toBeNull();
    expect(row.notepadVersion).toBe(0);
  });

  it("enregistre chiffré au repos, version +1, sans changer la date de la fiche ; un renvoi du même texte est sans effet", async () => {
    const client = await createClient({ type: "B2C" });
    const before = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    await new Promise((r) => setTimeout(r, 20));
    const res = await putPad(client.id, "Rappeler jeudi.", 0);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: "Rappeler jeudi.", version: 1, conflictAt: null, conflict: false });
    const row = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(row.notepadEncrypted).not.toContain("Rappeler");
    expect(decrypt(row.notepadEncrypted!)).toBe("Rappeler jeudi.");
    expect(row.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // Réponse perdue, même envoi rejoué (version lue dépassée) : pas de doublon, pas de conflit.
    const replay = await putPad(client.id, "Rappeler jeudi.", 0);
    expect(replay.json()).toMatchObject({ text: "Rappeler jeudi.", version: 1, conflict: false });
  });

  it("modifié ailleurs entre-temps : les deux textes gardés, bandeau « à relire » jusqu'au prochain enregistrement", async () => {
    const client = await createClient({ type: "B2C" });
    await putPad(client.id, "Texte du PC.", 0);
    const res = await putPad(client.id, "Texte de la tablette.", 0);
    const body = res.json();
    expect(body.conflict).toBe(true);
    expect(body.version).toBe(2);
    expect(body.conflictAt).not.toBeNull();
    expect(body.text).toMatch(/^Texte du PC\.\n\nVersion de l'appareil du \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}, à relire :\nTexte de la tablette\.$/);
    const relu = await putPad(client.id, "Texte relu et fusionné.", 2);
    expect(relu.json()).toMatchObject({ text: "Texte relu et fusionné.", version: 3, conflictAt: null, conflict: false });
  });

  it("texte vide : le bloc-notes est vidé, et une reprise ultérieure ne fait pas revenir les anciennes notes", async () => {
    const client = await legacyClient();
    const res = await putPad(client.id, "", 0);
    expect(res.json()).toMatchObject({ text: "", version: 1 });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).notepadEncrypted).toBeNull();
    expect(await notepadTakeover({ dryRun: false })).toEqual({ clients: 0, internalNotes: 0, appointmentNotes: 0 });
    expect((await getPad(client.id)).json().text).toBe("");
  });

  it("premier enregistrement avant la reprise : il part du texte montré, les anciennes notes ne sont pas perdues", async () => {
    const client = await legacyClient();
    const shown = (await getPad(client.id)).json() as { text: string; version: number };
    const res = await putPad(client.id, `${shown.text}\n\nAjout du jour.`, shown.version);
    expect(res.json()).toMatchObject({ text: `${LEGACY_TEXT}\n\nAjout du jour.`, version: 1, conflict: false });
  });

  it("refuse une entrée invalide (400), un client inconnu (404) et sans session (401)", async () => {
    const client = await createClient();
    expect((await app.inject({ method: "PUT", url: `/api/clients/${client.id}/notepad`, headers: { cookie }, payload: { text: 3 } })).statusCode).toBe(400);
    expect((await putPad(client.id, "x".repeat(50_001), 0)).statusCode).toBe(400);
    expect((await putPad("inconnu", "x", 0)).json()).toMatchObject({ code: "client_not_found" });
    expect((await getPad("inconnu")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/clients/${client.id}/notepad` })).statusCode).toBe(401);
  });
});

describe("bloc-notes : compatibilité avec les appareils pas encore mis à jour", () => {
  it("note de rendez-vous envoyée par la file d'un ancien appareil : ajoutée une seule fois en fin de bloc-notes", async () => {
    const client = await createClient({ type: "B2C" });
    await putPad(client.id, "Début.", 0);
    const payload = { body: "Note de la tablette.", clientRequestId: randomUUID(), preparedAt: "2026-10-18T08:15:00.000Z" };
    const first = await app.inject({ method: "POST", url: `/api/clients/${client.id}/notes`, headers: { cookie }, payload });
    const again = await app.inject({ method: "POST", url: `/api/clients/${client.id}/notes`, headers: { cookie }, payload });
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect((await getPad(client.id)).json()).toMatchObject({ text: "Début.\n\n18/10/2026 à 10:15 : Note de la tablette.", version: 2 });
  });

  it("note envoyée avant la reprise : le bloc-notes repris la contient une seule fois", async () => {
    const client = await legacyClient();
    const payload = { body: "Troisième rendez-vous.", clientRequestId: randomUUID(), preparedAt: "2026-10-18T08:15:00.000Z" };
    await app.inject({ method: "POST", url: `/api/clients/${client.id}/notes`, headers: { cookie }, payload });
    const text = (await getPad(client.id)).json().text as string;
    expect(text).toBe(`${LEGACY_TEXT}\n\n18/10/2026 à 10:15 : Troisième rendez-vous.`);
    expect(text.split("Troisième rendez-vous.").length).toBe(2);
  });

  it("client préparé hors ligne avec l'ancien champ « Notes internes » : il ouvre le bloc-notes ; en modification il est ignoré", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { type: "B2C", firstName: "Sam", lastName: "Durand", notes: "Vu au salon.", clientRequestId: randomUUID() },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await getPad(id)).json()).toMatchObject({ text: "Vu au salon.", version: 1 });
    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(row.notes).toBeNull();
    const put = await app.inject({ method: "PUT", url: `/api/clients/${id}`, headers: { cookie }, payload: { type: "B2C", firstName: "Sam", lastName: "Durand", notes: "Écrasé ?" } });
    expect(put.statusCode).toBe(200);
    expect((await getPad(id)).json()).toMatchObject({ text: "Vu au salon.", version: 1 });
  });

  it("export RGPD de la fiche : le bloc-notes en clair y figure", async () => {
    const client = await createClient({ type: "B2C" });
    await putPad(client.id, "Contenu à exporter.", 0);
    const res = await app.inject({ method: "GET", url: `/api/clients/${client.id}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().notepad).toBe("Contenu à exporter.");
  });
});

describe("reprise du bloc-notes", () => {
  it("à blanc : comptes justes, rien n'est écrit ; réelle : texte chiffré identique à l'aperçu, date de la fiche gardée ; relancée : zéro", async () => {
    const lou = await legacyClient();
    const vide = await createClient({ displayName: "Sans note", type: "B2B" });
    const internes = await createClient({ displayName: "Notes internes seules", type: "ASSOCIATION" });
    await prisma.client.update({ where: { id: internes.id }, data: { notes: "Bureau le mardi." } });
    const preview = (await getPad(lou.id)).json().text as string;
    const before = await prisma.client.findUniqueOrThrow({ where: { id: lou.id } });

    const dry = await runTakeovers({ dryRun: true });
    expect(dry.notepad).toEqual({ clients: 2, internalNotes: 2, appointmentNotes: 2 });
    expect(await prisma.client.count({ where: { notepadVersion: { gt: 0 } } })).toBe(0);
    expect(takeoverSummary(dry).join("\n")).toBe(
      "Reprise des données, comptes à blanc (rien n'est écrit) :\n  bloc-notes : 2 fiches remplies, 2 « Notes internes » reprises en tête, 2 notes de rendez-vous reprises",
    );

    const real = await runTakeovers({ dryRun: false });
    expect(real.notepad).toEqual(dry.notepad);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: lou.id } });
    expect(decrypt(after.notepadEncrypted!)).toBe(preview);
    expect(after.notepadVersion).toBe(1);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await getPad(internes.id)).json().text).toBe("Notes internes :\nBureau le mardi.");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: vide.id } })).notepadVersion).toBe(0);
    // Anciennes données gardées, en lecture seule.
    expect(after.notes).toBe("Préfère être appelée le matin.");
    expect(await prisma.clientNote.count({ where: { clientId: lou.id } })).toBe(2);

    expect((await runTakeovers({ dryRun: false })).notepad).toEqual({ clients: 0, internalNotes: 0, appointmentNotes: 0 });
    expect(JSON.stringify(real)).not.toMatch(/Lou|matin|rendez-vous|Bureau|cm[a-z0-9]{10}/);
  });

  it("une saisie faite entre l'aperçu à blanc et la reprise réelle l'emporte : la reprise ne l'écrase pas", async () => {
    const lou = await legacyClient();
    expect((await runTakeovers({ dryRun: true })).notepad.clients).toBe(1);
    await putPad(lou.id, "Saisi avant la reprise.", 0);
    expect((await runTakeovers({ dryRun: false })).notepad.clients).toBe(0);
    expect((await getPad(lou.id)).json().text).toBe("Saisi avant la reprise.");
  });
});
