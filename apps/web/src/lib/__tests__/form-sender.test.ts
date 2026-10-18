import { describe, expect, it } from "vitest";
import { formProspectName, isFormSender } from "@/pages/messaging/sender";

describe("message du formulaire du site", () => {
  it("nom du prospect : corps sur plusieurs lignes, aperçu sur une ligne, phrase avec un point", () => {
    expect(formProspectName("nom : Camille Martin\nemail : c@ex.fr")).toBe("Camille Martin");
    expect(formProspectName("nom : Camille Martin email : c@ex.fr telephone : 06")).toBe("Camille Martin");
    expect(formProspectName("Nom : Jean-Baptiste Lefebvre-Dumoulin. Message : Bonjour")).toBe("Jean-Baptiste Lefebvre-Dumoulin");
    expect(formProspectName("Bonjour, sans champ")).toBeNull();
  });

  it("expéditeur technique : domaine web3forms.com seulement", () => {
    expect(isFormSender("notify+abc@web3forms.com")).toBe(true);
    expect(isFormSender("NOTIFY@Web3Forms.com")).toBe(true);
    expect(isFormSender("notify@web3forms.com.evil.test")).toBe(false);
    expect(isFormSender(null)).toBe(false);
  });
});

describe("nom d'un message du formulaire (liste et tableau de bord)", () => {
  const form = { fromAddress: "notify+x@web3forms.com", snippet: "nom : Camille Martin email : c@ex.fr" };
  it("client rattaché, sinon nom saisi, sinon adresse du prospect ; jamais l'expéditeur technique", async () => {
    const { formMessageName } = await import("@/pages/messaging/sender");
    expect(formMessageName(form, "Atelier Martin")).toBe("Atelier Martin");
    expect(formMessageName(form)).toBe("Camille Martin");
    expect(formMessageName({ fromAddress: form.fromAddress, replyToAddress: "c@ex.fr" })).toBe("c@ex.fr");
    expect(formMessageName({ fromAddress: form.fromAddress })).toBe("Formulaire du site");
    expect(formMessageName({ fromAddress: "quelqu.un@exemple.fr", snippet: "nom : X" })).toBeNull();
    expect(formMessageName({ ...form, direction: "OUTBOUND" })).toBeNull();
  });
});
