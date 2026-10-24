import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { buildEmailContent, TEMPLATE_KEY, type EmailContentInput, type EmailTemplateKind } from "@/lib/email/templates.js";
import { fillTemplate, TEMPLATE_REGISTRY, templateDefinition, validateTemplate } from "@/lib/email/template-registry.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function input(kind: EmailTemplateKind, extra: Partial<EmailContentInput> = {}): Promise<EmailContentInput> {
  return {
    kind,
    clientName: "Lou Martin",
    clientFirstName: "Lou",
    docNumber: "F-2026-0042",
    brand: buildEmailBrand(await getCompanySettings()),
    clientPortalUrl: "https://kouzia.test/suivi/",
    ...extra,
  };
}

/** Variantes réelles de chaque type : lien de paiement, lignes d'information, sans prénom, nature du document. */
const VARIANTS: Array<[EmailTemplateKind, Partial<EmailContentInput>]> = [
  ["quote", {}],
  ["quote", { clientFirstName: null }],
  ["invoice", {}],
  ["invoice", { paymentUrl: "https://pay.test/abc" }],
  ["invoice_acompte", { paymentUrl: "https://pay.test/abc" }],
  ["invoice_solde", {}],
  ["credit_note", {}],
  ["reminder_soft", { docLabel: "facture" }],
  ["reminder_soft", { docLabel: "acompte", docNumber: "D-2026-0007", paymentUrl: "https://pay.test/x", extraLines: ["Jalon : Acompte de 30 %", "Échéance dans 7 jours", "Échéance : 01/11/2026"] }],
  ["reminder_soft", { docLabel: "devis", docNumber: "D-2026-0008" }],
  ["reminder_firm", { docLabel: "facture", paymentUrl: "https://pay.test/y" }],
  ["reminder_firm", { docLabel: "facture" }],
];

describe("modèles d'e-mails : texte d'origine identique au code, au caractère près", () => {
  it.each(VARIANTS)("%s %j : le modèle d'origine enregistré tel quel rend exactement l'e-mail du code", async (kind, extra) => {
    const data = await input(kind, extra);
    const fromCode = await buildEmailContent(data);
    const def = templateDefinition(TEMPLATE_KEY[kind]!)!;
    await prisma.emailTemplate.create({ data: { key: def.key, subject: def.subject, body: def.body } });
    const fromTemplate = await buildEmailContent(data);
    expect(fromTemplate.subject).toBe(fromCode.subject);
    expect(fromTemplate.text).toBe(fromCode.text);
    expect(fromTemplate.html).toBe(fromCode.html);
  });

  it("chaque type branché a son modèle dans le registre", () => {
    for (const key of Object.values(TEMPLATE_KEY)) expect(templateDefinition(key!)).not.toBeNull();
    expect(new Set(TEMPLATE_REGISTRY.map((t) => t.key)).size).toBe(TEMPLATE_REGISTRY.length);
  });
});

describe("modèle modifié", () => {
  it("s'applique aux e-mails construits ensuite ; signature du système ajoutée ; HTML échappé", async () => {
    await prisma.emailTemplate.create({
      data: { key: "document.invoice", subject: "Votre facture {{numero}} est prête", body: "{{salutation}}\n\nVoici la facture {{numero}} <b>du mois</b>.\n\nRégler en ligne : {{lien_paiement}}" },
    });
    const built = await buildEmailContent(await input("invoice", { paymentUrl: "https://pay.test/abc" }));
    expect(built.subject).toBe("Votre facture F-2026-0042 est prête");
    expect(built.text.startsWith("Bonjour Lou,\n\nVoici la facture F-2026-0042 <b>du mois</b>.\n\nRégler en ligne : https://pay.test/abc\n\n")).toBe(true);
    expect(built.html).toContain("&lt;b&gt;du mois&lt;/b&gt;");
    expect(built.html).not.toContain("<b>du mois</b>");
  });

  it("mise en demeure verrouillée : une ligne en base est ignorée, le texte du code part", async () => {
    const data = await input("reminder_formal", { docLabel: "facture" });
    const fromCode = await buildEmailContent(data);
    await prisma.emailTemplate.create({ data: { key: "reminder.formal", subject: "Autre", body: "{{numero}} autre texte" } });
    expect(await buildEmailContent(data)).toEqual(fromCode);
  });
});

describe("contrôle et remplissage d'un modèle", () => {
  it("variable inconnue, variable obligatoire retirée, champ vide, modèle verrouillé : refusés", () => {
    expect(validateTemplate("document.invoice", "Facture {{numero}}", "{{salutation}} {{montant_inconnu}}")).toEqual([
      { field: "body", code: "unknown_variable", variable: "montant_inconnu", message: "Variable inconnue : {{montant_inconnu}}." },
    ]);
    expect(validateTemplate("document.invoice", "Votre facture", "{{salutation}}").map((i) => i.code)).toEqual(["missing_required"]);
    expect(validateTemplate("document.invoice", "  ", "{{numero}}").map((i) => i.code)).toEqual(["empty"]);
    expect(validateTemplate("reminder.formal", "x", "{{numero}}").map((i) => i.code)).toEqual(["locked"]);
    expect(validateTemplate("document.quote", "Devis {{numero}}", "{{salutation}}\n\n{{bloc_suivi}}")).toEqual([]);
  });

  it("ligne dont toutes les variables sont vides retirée ; lignes vides resserrées", () => {
    expect(fillTemplate("A {{x}}\n\nB : {{lien}}\n\n\nC", { x: "1", lien: "" })).toBe("A 1\n\nC");
    expect(fillTemplate("Texte fixe\n{{vide}}\n", {})).toBe("Texte fixe");
  });
});
