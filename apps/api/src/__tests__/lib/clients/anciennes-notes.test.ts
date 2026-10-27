import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { backfillLegacyNotes, readNotepad, saveNotepad } from "@/lib/clients/notepad.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 : l'ancien champ Client.notes (en clair) est recopié dans le bloc-notes chiffré,
// puis vidé ; rattrapage idempotent, sans rien perdre.
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

const NOTE = "Préfère être appelé le matin. Code portail 4521.";

async function withLegacyNotes(notes: string | null) {
  const client = await createClient({ displayName: "Client Notes" });
  return prisma.client.update({ where: { id: client.id }, data: { notes } });
}

describe("rattrapage des anciennes notes", () => {
  it("fiche jamais reprise : notes et note de rendez-vous dans le bloc-notes chiffré, champ vidé, date de la fiche gardée", async () => {
    const client = await withLegacyNotes(NOTE);
    await prisma.clientNote.create({
      data: { clientId: client.id, clientRequestId: "note-rdv-1", preparedAt: new Date(2026, 8, 3, 10, 0), bodyEncrypted: encrypt("Rendez-vous : refonte du site") },
    });
    expect(await backfillLegacyNotes()).toBe(1);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    expect(after.notes).toBeNull();
    expect(after.updatedAt.getTime()).toBe(client.updatedAt.getTime());
    const text = (await readNotepad(client.id))!.text;
    expect(text).toContain(NOTE);
    expect(text).toContain("Rendez-vous : refonte du site");
    expect(after.notepadEncrypted).not.toContain("Préfère");
  });

  it("bloc-notes déjà écrit sans l'ancien texte : ajouté à la fin, rien de perdu", async () => {
    const client = await withLegacyNotes(NOTE);
    await saveNotepad(client.id, { text: "Nouveau texte saisi", baseVersion: 0 });
    expect(await backfillLegacyNotes()).toBe(1);
    const text = (await readNotepad(client.id))!.text;
    expect(text.startsWith("Nouveau texte saisi")).toBe(true);
    expect(text).toContain(NOTE);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).notes).toBeNull();
  });

  it("bloc-notes qui contient déjà le texte : pas de doublon ; idempotent ; notes vides simplement retirées", async () => {
    const a = await withLegacyNotes(NOTE);
    await saveNotepad(a.id, { text: `Notes internes :\n${NOTE}\n\nSuite`, baseVersion: 0 });
    const b = await withLegacyNotes("   ");
    expect(await backfillLegacyNotes()).toBe(2);
    expect((await readNotepad(a.id))!.text).toBe(`Notes internes :\n${NOTE}\n\nSuite`);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: b.id } })).notes).toBeNull();
    expect(await backfillLegacyNotes()).toBe(0);
  });
});
