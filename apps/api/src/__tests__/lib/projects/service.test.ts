import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import {
  createClientProject,
  listPortalProjects,
  projectInputSchema,
  updateClientProject,
} from "@/lib/projects/service.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

const input = projectInputSchema.parse({
  name: "Site vitrine",
  progress: 60,
  steps: [
    { label: "Maquettes", status: "done", date: "2026-09-20" },
    { label: "Développement", status: "current" },
  ],
  links: [{ label: "Démo", url: "https://exemple.fr/demo" }],
  checklist: [
    { label: "Nom de domaine réservé", done: true, note: "exemple.fr" },
    { label: "Textes fournis", done: false, note: "" },
  ],
});

describe("projets client", () => {
  it("refuse un lien qui n'est pas en https", () => {
    const parsed = projectInputSchema.safeParse({
      ...input,
      links: [{ label: "Démo", url: "http://exemple.fr" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("expose au portail le format attendu par /suivi, sans les projets masqués", async () => {
    const client = await createClient();
    await createClientProject(client.id, input);
    const hidden = await createClientProject(client.id, { ...input, name: "Brouillon" });
    await updateClientProject(hidden.id, { ...input, name: "Brouillon", visibleOnPortal: false });

    const projects = await listPortalProjects(client.id);
    expect(projects).toEqual([
      {
        // id et status : carte « Votre témoignage » d'un projet terminé (contrat convenu avec le site).
        id: expect.any(String),
        status: expect.any(String),
        name: "Site vitrine",
        progress: 60,
        steps: [
          { label: "Maquettes", status: "done", date: "2026-09-20" },
          { label: "Développement", status: "current", date: null },
        ],
        links: [{ label: "Démo", url: "https://exemple.fr/demo" }],
        checklist: [
          { label: "Nom de domaine réservé", done: true, note: "exemple.fr" },
          { label: "Textes fournis", done: false, note: null },
        ],
      },
    ]);
  });
});
