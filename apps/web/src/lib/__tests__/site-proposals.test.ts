import { describe, expect, it } from "vitest";
import { applyProposals, proposeCaptureAlt, proposePairAlt, readableMediaName, type CaptureDraft, type PairDraft } from "@/lib/site-proposals";

const IMG_A = "/media/aaaaaaaaaaaa.webp";
const IMG_B = "/media/bbbbbbbbbbbb.webp";
const names = {
  aaaaaaaaaaaa: { label: null, originalName: "page-contact.png" },
  bbbbbbbbbbbb: { label: null, originalName: "Screenshot 2026-10-23 at 14.02.11.png" },
};
const capture = (patch: Partial<CaptureDraft> = {}): CaptureDraft => ({ image: null, alt: "", caption: "", vue: "bureau", ...patch });
const form = (patch: Record<string, unknown> = {}) => ({
  kind: "WEBSITE",
  name: "Tracebay",
  nature: "refonte",
  captures: [] as CaptureDraft[],
  avantApres: [] as PairDraft[],
  ...patch,
});

describe("nom lisible d'un média", () => {
  it("libellé d'abord, puis nom du fichier s'il décrit quelque chose ; captures d'écran et empreintes écartées", () => {
    expect(readableMediaName({ label: "Tableau de bord", originalName: "x.png" })).toBe("Tableau de bord");
    expect(readableMediaName({ label: null, originalName: "page_contact-final.webp" })).toBe("Page contact final");
    expect(readableMediaName({ label: null, originalName: "Screenshot 2026-10-23 at 14.02.11.png" })).toBeNull();
    expect(readableMediaName({ label: null, originalName: "IMG_20261023_140211.jpg" })).toBeNull();
    expect(readableMediaName({ label: null, originalName: "Capture d’écran 2026-10-23.png" })).toBeNull();
    expect(readableMediaName({ label: null, originalName: "3f9a2c0b7d1e4f.png" })).toBeNull();
    expect(readableMediaName(undefined)).toBeNull();
  });

  it("le libellé passe le même filtre : tiré du nom de fichier à l'envoi, ou libellé d'usage d'une image reprise du site", () => {
    expect(readableMediaName({ label: "page-contact", originalName: "page-contact.png" })).toBe("Page contact");
    expect(readableMediaName({ label: "Screenshot 2026-10-23 at 14.02.11", originalName: "Screenshot 2026-10-23 at 14.02.11.png" })).toBeNull();
    expect(readableMediaName({ label: "Capture 1 de la page projet « Tracebay »", originalName: null })).toBeNull();
    expect(readableMediaName({ label: "Avant (bureau) de « Tracebay »", originalName: "accueil.png" })).toBe("Accueil");
  });
});

describe("propositions", () => {
  it("capture : nom du média s'il est lisible, sinon vue et rang parmi les captures de la même vue", () => {
    const caps = [capture({ image: IMG_A }), capture({ image: IMG_B }), capture({ vue: "mobile" }), capture({ image: IMG_B, vue: "bureau" })];
    const f = form({ captures: caps });
    expect(proposeCaptureAlt(f, caps, 0, names)).toBe("Site Tracebay : page contact, vue ordinateur");
    expect(proposeCaptureAlt(f, caps, 1, names)).toBe("Site Tracebay, vue ordinateur 2");
    expect(proposeCaptureAlt(f, caps, 2, names)).toBe("Site Tracebay, vue téléphone");
    expect(proposeCaptureAlt(form({ kind: "SOFTWARE" }), caps, 3, names)).toBe("Logiciel Tracebay, vue ordinateur 3");
    expect(proposeCaptureAlt(form({ name: " " }), caps, 0, names)).toBe("");
  });

  it("avant / après : moment, vue et mois de l'archive", () => {
    const pair: PairDraft = { vue: "bureau", avant: { image: IMG_A, alt: "", date: "2023-03" }, apres: { image: IMG_B, alt: "" } };
    expect(proposePairAlt(form(), pair, "avant")).toBe("Site Tracebay avant la refonte, vue ordinateur, mars 2023");
    expect(proposePairAlt(form({ nature: "" }), pair, "apres")).toBe("Site Tracebay après, vue ordinateur");
  });
});

describe("texte proposé ou retouché", () => {
  it("un texte vide devient proposé et suit le contexte ; un texte retouché ne bouge plus", () => {
    let f = applyProposals(form({ captures: [capture({ image: IMG_A }), capture({ alt: "Écrit à la main", vue: "mobile" })] }), names);
    expect(f.captures[0]).toMatchObject({ alt: "Site Tracebay : page contact, vue ordinateur", caption: "Page contact", altAuto: true, captionAuto: true });
    expect(f.captures[1]).toMatchObject({ alt: "Écrit à la main", altAuto: false });

    f = applyProposals({ ...f, name: "Tracebay Pro" }, names);
    expect(f.captures[0]!.alt).toBe("Site Tracebay Pro : page contact, vue ordinateur");
    expect(f.captures[1]!.alt).toBe("Écrit à la main");
  });

  it("au chargement, un texte égal à la proposition est reconnu comme proposé ; rien ne change : même objet", () => {
    const loaded = form({ captures: [capture({ image: IMG_A, alt: "Site Tracebay : page contact, vue ordinateur", caption: "Page contact" })] });
    const once = applyProposals(loaded, names);
    expect(once.captures[0]).toMatchObject({ altAuto: true, captionAuto: true });
    expect(applyProposals(once, names)).toBe(once);
  });

  it("paire : chaque côté proposé suit la vue et la date", () => {
    const pair: PairDraft = { vue: "bureau", avant: { image: IMG_A, alt: "", date: "2023-03" }, apres: { image: IMG_B, alt: "Ma version" } };
    let f = applyProposals(form({ avantApres: [pair] }), names);
    expect(f.avantApres[0]!.avant.alt).toBe("Site Tracebay avant la refonte, vue ordinateur, mars 2023");
    f = applyProposals({ ...f, avantApres: [{ ...f.avantApres[0]!, vue: "mobile" }] }, names);
    expect(f.avantApres[0]!.avant.alt).toBe("Site Tracebay avant la refonte, vue téléphone, mars 2023");
    expect(f.avantApres[0]!.apres).toMatchObject({ alt: "Ma version", altAuto: false });
  });
});
