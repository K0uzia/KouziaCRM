import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formLeadEmail, isWeb3FormsSender, parseWeb3FormsBody } from "@/lib/email/web3forms.js";

describe("analyse du formulaire Web3Forms", () => {
  it("texte : espaces autour du « : », accents, champ vide, message sur plusieurs lignes", () => {
    const lead = parseWeb3FormsBody(
      ["Nom:Élodie Bérard", "  E-mail   :   ELODIE@Exemple.fr ", "Téléphone :", "Structure : Café Noël", "message : Bonjour", "suite du message"].join("\r\n"),
    );
    expect(lead).toEqual({
      name: "Élodie Bérard",
      email: "elodie@exemple.fr",
      phone: null,
      company: "Café Noël",
      project: null,
      message: "Bonjour\nsuite du message",
    });
  });

  it("HTML (tableau ou lignes <br>)", () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/emails/web3forms.html"), "utf8");
    expect(parseWeb3FormsBody(html).name).toBe("Camille Dupont");
    expect(parseWeb3FormsBody("<p>nom : Jean &amp; Fils<br>email : <a href=\"mailto:jean@ex.fr\">jean@ex.fr</a></p>")).toMatchObject({
      name: "Jean & Fils",
      email: "jean@ex.fr",
    });
  });

  it("adresse invalide ignorée ; Reply-To prioritaire, sauf s'il pointe vers Web3Forms", () => {
    expect(parseWeb3FormsBody("email : pas-une-adresse").email).toBeNull();
    expect(formLeadEmail({ replyToAddress: "a@ex.fr", body: "email : b@ex.fr" })).toBe("a@ex.fr");
    expect(formLeadEmail({ replyToAddress: "notify@web3forms.com", body: "email : b@ex.fr" })).toBe("b@ex.fr");
    expect(formLeadEmail({ replyToAddress: null, body: "email : b@ex.fr" })).toBe("b@ex.fr");
  });

  it("expéditeur : domaine web3forms.com seulement", () => {
    expect(isWeb3FormsSender("notify+x1@web3forms.com")).toBe(true);
    expect(isWeb3FormsSender("NOTIFY@Web3Forms.com")).toBe(true);
    expect(isWeb3FormsSender("notify@web3forms.com.evil.test")).toBe(false);
    expect(isWeb3FormsSender("contact@kouzia.com")).toBe(false);
    expect(isWeb3FormsSender(null)).toBe(false);
  });
});
