import { describe, expect, it } from "vitest";
import {
  collectFields,
  fieldPages,
  getAt,
  itemTitle,
  normalizeSearch,
  pageLabel,
  phrasesOf,
  phraseText,
  renderPhrase,
  searchText,
  type Path,
  type Phrase,
  type PhraseContext,
  type SchemaNode,
} from "../site-editor";
import raw from "../../../../api/src/__tests__/fixtures/site/contenu.schema.editeur.json?raw";

const contract = JSON.parse(raw) as { fichiersFacultatifs: Record<string, SchemaNode>; defauts: Record<string, unknown> };
const defaults = { pages: contract.defauts.pages, communs: contract.defauts.communs };

// Déclaration exportée par le site (KouziaWebsite, src/content/schema.ts, PHRASES_PAGES), telle que dans contenu.schema.json.
const mo = (k: string) => `pages.accueil.maintenanceOption.${k}`;
const phrases: Phrase[] = [
  {
    morceaux: [{ champ: mo("titre"), gras: true }, ", ", { champ: mo("texte") }, " ", { champ: mo("details") }, " ", { champ: mo("sitesWeb"), lien: true }, " et ", { champ: mo("logiciels"), lien: true }, "."],
  },
  { morceaux: [{ champ: "pages.accueil.contact.intro", sansPointFinal: true }, { champ: "communs.appelContact.suite" }] },
  { morceaux: [{ champ: "pages.sitesWeb.autre" }, " ", { champ: "communs.pageService.exemples.lienAutre", lien: true }, " ", { page: "logiciels", lien: true }, "."] },
];
const schema: SchemaNode = { ...contract.fichiersFacultatifs["pages.json"]!, phrases };

const ctx = (draft: Record<string, unknown> | null = null): PhraseContext => ({
  value: (path: Path) => getAt(draft, path) ?? getAt(defaults, path),
  page: (id) => ({ logiciels: "Logiciels" })[id] ?? id,
  variables: { ville: "Huelgoat", delaiReponse: "sous 24 h" },
});
const MAINTENANCE = "Maintenance en option, pour un site comme pour un logiciel : surveillance 24 h/24, sauvegardes, mises à jour et retouches. Détails sur les pages sites web et logiciels.";

describe("aperçu d'une phrase assemblée de plusieurs champs", () => {
  it("la suite de la phrase de maintenance montre la phrase entière de l'accueil, ce champ marqué", () => {
    const path = ["pages", "accueil", "maintenanceOption", "texte"];
    const [ph] = phrasesOf(schema, path);
    expect(ph).toBeDefined();
    const segments = renderPhrase(ph!, ctx(), path);
    expect(normalizeSearch(phraseText(segments))).toBe(normalizeSearch(MAINTENANCE));
    expect(segments.filter((s) => s.current).map((s) => s.text)).toEqual([getAt(defaults, path)]);
    expect(segments.find((s) => s.text === "Maintenance en option")).toMatchObject({ gras: true, current: false });
    expect(segments.filter((s) => s.lien).map((s) => s.text)).toEqual(["sites web", "logiciels"]);
  });

  it("valeur en cours de saisie reprise en direct ; champ hors phrase : aucun aperçu", () => {
    const path = ["pages", "accueil", "maintenanceOption", "titre"];
    const draft = { pages: { accueil: { maintenanceOption: { titre: "Suivi en option" } } } };
    const text = phraseText(renderPhrase(phrasesOf(schema, path)[0]!, ctx(draft), path));
    expect(text.startsWith("Suivi en option, pour un site comme pour un logiciel")).toBe(true);
    expect(phrasesOf(schema, ["pages", "accueil", "hero", "titre"])).toEqual([]);
  });

  it("bandeau d'appel : introduction sans son point final, suite avec la variable remplacée ; nom de page lu", () => {
    const path = ["communs", "appelContact", "suite"];
    const text = phraseText(renderPhrase(phrasesOf(schema, path)[0]!, ctx()));
    expect(text).not.toMatch(/\.\s*,/);
    expect(text).toMatch(/sous 24 h\.$/);
    const autre = phraseText(renderPhrase(phrasesOf(schema, ["pages", "sitesWeb", "autre"])[0]!, ctx()));
    expect(autre).toMatch(/ Logiciels\.$/);
  });
});

describe("recherche sur le texte lu sur le site", () => {
  const fields = collectFields("pages", schema);
  const found = (query: string) =>
    fields.filter((f) => searchText(f, schema, ctx()).includes(normalizeSearch(query))).map((f) => f.path.join("."));

  it("une phrase à cheval sur plusieurs champs trouve chacun de ses champs", () => {
    const hits = found("Maintenance en option, pour un site comme pour un logiciel");
    expect(hits).toEqual(expect.arrayContaining([mo("titre"), mo("texte"), mo("details"), mo("sitesWeb"), mo("logiciels")]));
  });

  it("sans casse, sans accents, espaces insécables compris", () => {
    expect(found("MISES A JOUR ET RETOUCHES. details sur les pages")).toContain(mo("texte"));
    expect(found("surveillance 24 h/24")).toContain(mo("texte"));
  });

  it("texte actuel du site trouvé même sans saisie dans l'ERP, variables remplacées", () => {
    expect(found("et je réponds sous 24 h")).toContain("communs.appelContact.suite");
  });
});

describe("titres et emplacements lisibles", () => {
  const etapes = contract.fichiersFacultatifs["pages.json"]!.properties!.communs!.properties!.methode!.properties!.etapes!;

  it("élément de liste titré par son champ titre, jamais par son icône", () => {
    const items = getAt(defaults, ["communs", "methode", "etapes"]) as Record<string, unknown>[];
    expect(itemTitle(etapes.items!, items[4])).toBe("Je maintiens");
    expect(itemTitle(etapes.items!, { icone: "wrench", titre: "", texte: "Surveillance et mises à jour." })).toBe("Surveillance et mises à jour.");
    expect(itemTitle(etapes.items!, { icone: "wrench" })).toBeNull();
  });

  it("noms de pages lisibles, jamais la clé technique ; pages d'affichage d'un texte commun", () => {
    expect(pageLabel("planDuSite", {})).toBe("Plan du site");
    expect(pageLabel("cgv", {})).toBe("CGV");
    expect(pageLabel("nouvellePage", {})).toBe("Nouvelle page");
    expect(fieldPages({ libelle: "Titre", page: "global", section: "Méthode", type: "court", affichage: ["accueil", "sitesWeb", "logiciels"] })).toEqual(["accueil", "sitesWeb", "logiciels"]);
    expect(fieldPages({ libelle: "Titre", page: "accueil", section: "Haut de page", type: "court" })).toEqual(["accueil"]);
  });
});
