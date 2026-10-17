import { describe, expect, it } from "vitest";
import { formatEUR, formatLongDate } from "@/lib/money.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { htmlSignatureToPlain } from "@/lib/email/signature.js";
import { readableOn, resolveBrandColors } from "@/lib/brand.js";

const brand = {
  tradeName: "Kouzia",
  legalName: "Alexandre Kouziaeff",
  siret: "10858002800018",
  addressLine1: "13 Le Petit Moulin",
  postalCode: "29690",
  city: "Huelgoat",
};

describe("montants", () => {
  it("n'utilise pas l'espace fine U+202F (rendue « / » dans les PDF)", () => {
    const s = formatEUR(119000);
    expect(s).toBe("1 190,00 €");
    expect(s).not.toMatch(/[  ]/);
  });
});

describe("dates longues", () => {
  it("écrit « 1er » le premier du mois, le jour seul sinon", () => {
    expect(formatLongDate(new Date(2026, 11, 1))).toBe("1er décembre 2026");
    expect(formatLongDate(new Date(2026, 11, 11))).toBe("11 décembre 2026");
    expect(formatLongDate(new Date(2026, 11, 21))).toBe("21 décembre 2026");
  });
});

describe("email HTML", () => {
  it("site saisi sans schéma : lien absolu en https dans le pied", () => {
    const html = renderEmailHtml({ text: "x", brand: { ...brand, website: "kouzia.com" } });
    expect(html).toContain('href="https://kouzia.com"');
    expect(html).toContain(">kouzia.com</a>");
    expect(renderEmailHtml({ text: "x", brand: { ...brand, website: "http://a.test" } })).toContain('href="http://a.test"');
  });

  it("contient tout le texte, pas seulement le bouton de paiement", () => {
    const html = renderEmailHtml({
      text: "Bonjour Lou,\n\nVeuillez trouver ci-joint la facture F-1.\n\nRégler en ligne : https://pay.test/x\n\nCordialement,\nKouzia",
      brand,
      paymentUrl: "https://pay.test/x",
    });
    expect(html).toContain("Veuillez trouver ci-joint la facture F-1.");
    expect(html).toContain("Cordialement,<br>Kouzia");
    expect(html).toContain('href="https://pay.test/x"');
    expect(html).toContain("Payer en ligne");
  });

  it("échappe le contenu et applique la charte par défaut", () => {
    const html = renderEmailHtml({ text: "<b>x</b>", brand, colors: { brandPrimaryColor: "vert" } });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("#fe9a00");
    expect(html).not.toContain("vert");
  });
});

describe("signature", () => {
  it("garde les retours à la ligne et décode les entités", () => {
    const plain = htmlSignatureToPlain(
      "<p>Cordialement,<br>Alex</p><div>Kouzia &ndash; cr&eacute;ation &amp; maintenance</div><div>06&nbsp;00</div>",
    );
    expect(plain).toBe("Cordialement,\nAlex\nKouzia - création & maintenance\n06 00");
  });
});

describe("couleurs de marque", () => {
  it("remplace une couleur absente ou invalide par la charte, garde une couleur choisie", () => {
    expect(resolveBrandColors({ brandPrimaryColor: "", brandSecondaryColor: "bleu" })).toEqual({
      primary: "#fe9a00",
      secondary: "#0b1020",
    });
    expect(resolveBrandColors({ brandPrimaryColor: "#123456" }).primary).toBe("#123456");
    expect(resolveBrandColors({ brandPrimaryColor: "#0F766E" }).primary).toBe("#0f766e");
    expect(readableOn("#fe9a00")).toBe("#1a1103");
    expect(readableOn("#0b1020")).toBe("#ffffff");
  });
});
