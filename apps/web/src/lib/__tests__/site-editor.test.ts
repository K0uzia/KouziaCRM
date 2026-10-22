import { describe, expect, it } from "vitest";
import { choices, collectFields, getAt, setAt, skeleton, textConstraints, type SchemaNode } from "../site-editor";
// Contrat réel du site (fixture de l'API) : les champs générés suivent ses clés « editeur ».
import raw from "../../../../api/src/__tests__/fixtures/site/contenu.schema.editeur.json?raw";

const contract = JSON.parse(raw) as { fichiers: Record<string, SchemaNode>; fichiersFacultatifs: Record<string, SchemaNode>; defauts: Record<string, unknown> };

describe("éditeur généré depuis le contrat du site", () => {
  it("champs racines de pages.json : page tracebay comprise, chemin et type repris du schéma", () => {
    const fields = collectFields("pages", contract.fichiersFacultatifs["pages.json"]!);
    const hero = fields.find((f) => f.path.join(".") === "pages.accueil.hero.titre")!;
    expect(hero.editeur).toMatchObject({ page: "accueil", type: "titreAccent" });
    expect(fields.some((f) => f.editeur.page === "tracebay")).toBe(true);
    // Une liste d'objets est un champ ; ses enfants ne sont pas des champs racines.
    expect(fields.some((f) => f.path.join(".") === "pages.accueil.engagements.liste")).toBe(true);
    expect(fields.some((f) => f.path.join(".").startsWith("pages.accueil.engagements.liste."))).toBe(false);
  });

  it("chaque type « editeur » du contrat a sa commande dans l'écran", () => {
    const types = new Set<string>();
    const walk = (n: SchemaNode | undefined) => {
      if (!n) return;
      if (n.editeur) types.add(n.editeur.type);
      Object.values(n.properties ?? {}).forEach(walk);
      walk(n.items);
      (n.anyOf ?? []).forEach(walk);
    };
    Object.values({ ...contract.fichiers, ...contract.fichiersFacultatifs }).forEach(walk);
    const handled = ["court", "long", "titreAccent", "liste", "listeObjets", "objet", "choix", "lien", "image", "date", "nombre", "email", "telephone", "identifiant", "booleen"];
    expect([...types].filter((t) => !handled.includes(t))).toEqual([]);
  });

  it("setAt : pose une valeur sans toucher l'original ; undefined retire la clé et les objets vidés", () => {
    const doc = { pages: { accueil: { hero: { titre: "A" } } } };
    const next = setAt(doc, ["pages", "accueil", "hero", "surTitre"], "B");
    expect(doc.pages.accueil.hero).toEqual({ titre: "A" });
    expect(getAt(next, ["pages", "accueil", "hero", "surTitre"])).toBe("B");
    const cleared = setAt(setAt(next, ["pages", "accueil", "hero", "surTitre"], undefined), ["pages", "accueil", "hero", "titre"], undefined);
    expect(cleared).toEqual({ pages: {} });
    expect(setAt({ l: ["a", "b", "c"] }, ["l", 1], undefined)).toEqual({ l: ["a", "c"] });
  });

  it("squelette d'un élément de liste : propriétés obligatoires seulement ; choix et contraintes lus dans le schéma", () => {
    const pied = contract.fichiersFacultatifs["menus.json"]!.properties!.pied!;
    expect(skeleton(pied.items!)).toEqual({ cible: "accueil" });
    expect(choices(pied.items!.properties!.cible!)).toContain("tracebay");
    expect(textConstraints(pied.items!.properties!.libelle!).maxLength).toBe(30);
  });
});
