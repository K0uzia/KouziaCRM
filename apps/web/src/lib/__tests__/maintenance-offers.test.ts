import { describe, expect, it } from "vitest";
import { oneOffOffer } from "../maintenance-offers";

const pack = { id: "kouzia-maintenance-site-pack", unitPriceCents: 19_700 };
const seule = { id: "kouzia-maintenance-site", unitPriceCents: 35_000 };

describe("maintenance en paiement unique", () => {
  it("la maintenance pack est proposée sous la maintenance vendue seule (350 €)", () => {
    expect(oneOffOffer(pack, [pack, seule])).toBe(seule);
  });
  it("une autre offre, ou la maintenance seule absente du catalogue : inchangée", () => {
    const autre = { id: "x", unitPriceCents: 1 };
    expect(oneOffOffer(autre, [pack, seule, autre])).toBe(autre);
    expect(oneOffOffer(pack, [pack])).toBe(pack);
    expect(oneOffOffer(seule, [pack, seule])).toBe(seule);
  });
});
