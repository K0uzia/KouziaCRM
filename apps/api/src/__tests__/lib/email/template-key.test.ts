import { beforeEach, describe, expect, it } from "vitest";
import { templateDefinition, templateKeyFor } from "@/lib/email/template-registry.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { listReviewQueue } from "@/lib/email/review.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// « Modifier le modèle » (Vérifier l'e-mail, E-mails à valider) : le type d'un e-mail mène au modèle qui en donne le texte.
const KINDS = [
  "quote", "invoice", "invoice_acompte", "invoice_solde", "credit_note", "reminder_soft", "reminder_firm", "reminder_formal",
  "deposit_checkout", "payment_received", "payment_failed", "subscription_setup", "subscription_payment_failed",
  "subscription_payment_recovered", "subscription_suspended", "subscription_action_required", "subscription_action_reminder",
  "subscription_cancel_scheduled", "subscription_cancel_revoked", "subscription_cancel_request", "subscription_renewal",
  "subscription_term_end", "subscription_term_end_buyout", "subscription_first_charge", "subscription_card_expiring",
  "access", "onboarding", "client_renewal", "portal_alert",
];

describe("modèle d'un e-mail d'après son type", () => {
  it("chaque type mène à un modèle du registre", () => {
    for (const kind of KINDS) {
      const key = templateKeyFor(kind);
      expect(key && templateDefinition(key), kind).toBeTruthy();
    }
  });

  it("reçu de paiement (type de sa facture) et acompte reçu sans facture ; sans modèle : null", () => {
    expect(templateKeyFor("invoice_acompte", "payment_receipt")).toBe("payment.receipt");
    expect(templateKeyFor("payment_received", "payment_receipt")).toBe("payment.deposit_paid");
    expect(templateKeyFor("quote", "signature_confirmation")).toBeNull();
    expect(templateKeyFor("subscription_invoice", "subscription_invoice")).toBeNull();
    expect(templateKeyFor("testimonial", "review_invite")).toBeNull();
    expect(templateKeyFor("custom")).toBeNull();
    expect(templateKeyFor(null)).toBeNull();
  });
});

describe("E-mails à valider : modèle de chaque ligne", () => {
  beforeEach(async () => {
    await resetDb();
    await seedCompanySettings();
  });

  it("templateKey exposé, null pour un e-mail sans modèle", async () => {
    await mailEnqueue({ to: "lou@example.com", subject: "Reconduction", text: "x", kind: "subscription_renewal" }, { review: { family: "subscription_notice", origin: "WORKER" } });
    await mailEnqueue({ to: "lou@example.com", subject: "Devis signé", text: "x", kind: "quote" }, { review: { family: "signature_confirmation", origin: "CLIENT_ACTION" } });
    const { pending } = await listReviewQueue();
    expect(Object.fromEntries(pending.map((r) => [r.subject, r.templateKey]))).toEqual({ Reconduction: "subscription.renewal", "Devis signé": null });
  });
});
