import { describe, expect, it } from "vitest";
import { parseIsoDate, parseTypedDate, toIsoDate } from "@/components/ui/DatePicker";

describe("champ date : saisie au clavier et valeur AAAA-MM-JJ", () => {
  it("JJ/MM/AAAA, avec / . - ou espace, jour et mois sur un chiffre acceptés", () => {
    expect(parseTypedDate("05/03/2027")).toBe("2027-03-05");
    expect(parseTypedDate("5.3.2027")).toBe("2027-03-05");
    expect(parseTypedDate(" 29-02-2028 ")).toBe("2028-02-29");
    expect(parseTypedDate("1 12 2026")).toBe("2026-12-01");
  });

  it("date impossible, incomplète ou au mauvais format : refusée", () => {
    expect(parseTypedDate("31/04/2027")).toBeNull();
    expect(parseTypedDate("29/02/2027")).toBeNull();
    expect(parseTypedDate("05/03/27")).toBeNull();
    expect(parseTypedDate("2027-03-05")).toBeNull();
    expect(parseTypedDate("")).toBeNull();
  });

  it("valeur du champ : lue en date locale, réécrite à l'identique", () => {
    const d = parseIsoDate("2026-10-23")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 23]);
    expect(toIsoDate(d)).toBe("2026-10-23");
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });
});
