import { describe, expect, it } from "vitest";
import {
  analyzeSuspicion,
  baseDomain,
  lookalikeOf,
  misleadingLinks,
  parseAuthenticationResults,
  suspicionBanner,
  type SuspicionInput,
} from "@/lib/email/suspicion.js";

const base: SuspicionInput = {
  fromAddress: "contact@asso-exemple.fr",
  fromName: "Asso Exemple",
  replyToAddress: null,
  authHeaders: null,
  html: null,
  knownSender: false,
  firstContact: false,
  knownDomains: [],
};

const codes = (input: Partial<SuspicionInput>) => analyzeSuspicion({ ...base, ...input }).map((s) => s.code);

describe("analyse d'un message douteux", () => {
  it("message ordinaire : aucun signal", () => {
    expect(codes({})).toEqual([]);
  });

  it("lit le premier en-tête Authentication-Results, replié sur plusieurs lignes", () => {
    const raw =
      "Authentication-Results: mx.ovh.net;\r\n\tspf=pass smtp.mailfrom=a.fr;\r\n\tdkim=fail header.d=a.fr;\r\n\tdmarc=fail header.from=a.fr\r\n" +
      "Authentication-Results: faux.exemple; dmarc=pass";
    expect(parseAuthenticationResults(raw)).toEqual({ spf: "pass", dkim: ["fail"], dmarc: "fail" });
    expect(parseAuthenticationResults(null)).toBeNull();
    expect(parseAuthenticationResults("Received: from x")).toBeNull();
  });

  it("DMARC en échec : signal fort", () => {
    const signals = analyzeSuspicion({ ...base, authHeaders: "Authentication-Results: mx; dmarc=fail" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ code: "dmarc_fail", strong: true });
  });

  it("SPF en échec sans DKIM valide : signal fort ; avec DKIM valide : rien", () => {
    expect(codes({ authHeaders: "Authentication-Results: mx; spf=softfail; dkim=none" })).toEqual(["spf_fail"]);
    expect(codes({ authHeaders: "Authentication-Results: mx; spf=fail; dkim=pass" })).toEqual([]);
  });

  it("nom affiché avec l'adresse ou le domaine d'un autre", () => {
    expect(codes({ fromName: "service@banque.fr", fromAddress: "x@pirate.test" })).toEqual(["display_name"]);
    expect(codes({ fromName: "Support banque.fr", fromAddress: "x@pirate.test" })).toEqual(["display_name"]);
    expect(codes({ fromName: "Support asso-exemple.fr" })).toEqual([]);
  });

  it("liens dont le texte affiche une autre adresse que la destination", () => {
    const html =
      '<a href="https://pirate.test/login">www.banque.fr</a>' +
      '<a href="https://www.banque.fr/compte">https://banque.fr</a>' +
      '<a href="https://pirate.test/x">Cliquez ici</a>';
    expect(misleadingLinks(html)).toEqual([{ shown: "www.banque.fr", target: "pirate.test" }]);
    expect(codes({ html })).toEqual(["link_mismatch"]);
  });

  it("domaine qui imite un domaine connu", () => {
    expect(lookalikeOf("kouzla.com", ["kouzia.com"])).toBe("kouzia.com");
    expect(lookalikeOf("kouzia.fr", ["kouzia.com"])).toBe("kouzia.com");
    expect(lookalikeOf("mail.kouzia.com", ["kouzia.com"])).toBeNull();
    expect(lookalikeOf("gmail.com", ["gmail.fr"])).toBeNull();
    expect(codes({ fromAddress: "facture@kouzla.com", knownDomains: ["kouzia.com"] })).toEqual(["lookalike"]);
    expect(codes({ fromAddress: "a@xn--kouza-9ua.com" })).toEqual(["punycode"]);
  });

  it("premier contact et Reply-To : signaux faibles, sans bannière seuls", () => {
    const signals = analyzeSuspicion({
      ...base,
      fromAddress: "jean@gmail.com",
      replyToAddress: "autre@ailleurs.test",
      firstContact: true,
    });
    expect(signals.map((s) => [s.code, s.strong])).toEqual([
      ["reply_to", false],
      ["first_contact", false],
    ]);
    expect(signals[1]!.text).toContain("messagerie gratuite");
    expect(suspicionBanner(signals)).toEqual([]);
  });

  it("formulaire du site : le Reply-To du prospect n'est pas suspect", () => {
    expect(codes({ fromAddress: "notify@web3forms.com", replyToAddress: "p@gmail.com", formSender: true })).toEqual([]);
  });

  it("un signal fort affiche la bannière avec les signaux faibles", () => {
    const signals = analyzeSuspicion({ ...base, firstContact: true, authHeaders: "Authentication-Results: mx; dmarc=fail" });
    expect(suspicionBanner(signals).map((s) => s.code)).toEqual(["dmarc_fail", "first_contact"]);
  });

  it("client connu : pas de signal premier contact", () => {
    expect(codes({ firstContact: true, knownSender: true })).toEqual([]);
  });

  it("domaine enregistré", () => {
    expect(baseDomain("mail.banque.fr")).toBe("banque.fr");
    expect(baseDomain("shop.exemple.co.uk")).toBe("exemple.co.uk");
  });
});
