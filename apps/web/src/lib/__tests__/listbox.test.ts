import { createElement as h, Fragment } from "react";
import { describe, expect, it } from "vitest";
import { firstEnabled, lastEnabled, readOptions, step, typeahead } from "@/lib/listbox";

const options = readOptions([
  h("option", { key: "a", value: "" }, "Aucune"),
  h("option", { key: "b", value: "PERCENT" }, "En %"),
  h("option", { key: "c", value: "FIXED", disabled: true }, "En €"),
  h("optgroup", { key: "g", label: "Société" }, [
    h("option", { key: "d", value: "id" }, "Identité"),
    h(Fragment, { key: "f" }, h("option", { value: "ic" }, "Icône ", 2)),
  ]),
  h("option", { key: "e", value: "en" }, "Envoi"),
]);

describe("liste de choix (Listbox)", () => {
  it("lit les options, groupes, fragments et libellés composés", () => {
    expect(options.map((o) => [o.value, o.label, o.disabled, o.group])).toEqual([
      ["", "Aucune", false, null],
      ["PERCENT", "En %", false, null],
      ["FIXED", "En €", true, null],
      ["id", "Identité", false, "Société"],
      ["ic", "Icône 2", false, "Société"],
      ["en", "Envoi", false, null],
    ]);
  });

  it("recherche par frappe : accents ignorés, options désactivées sautées, lettre répétée qui avance", () => {
    expect(typeahead(options, "e", 0)).toBe(1);
    expect(typeahead(options, "e", 1)).toBe(5);
    expect(typeahead(options, "en", 1)).toBe(1);
    expect(typeahead(options, "env", 1)).toBe(5);
    expect(typeahead(options, "ide", 0)).toBe(3);
    expect(typeahead(options, "ii", 3)).toBe(4);
    expect(typeahead(options, "z", 0)).toBe(-1);
  });

  it("déplacement : options désactivées sautées, arrêt aux bords", () => {
    expect(step(options, 1, 1)).toBe(3);
    expect(step(options, 5, 1)).toBe(5);
    expect(step(options, 3, -1)).toBe(1);
    expect(step(options, 0, 10)).toBe(5);
    expect(firstEnabled(options)).toBe(0);
    expect(lastEnabled(options)).toBe(5);
  });
});
