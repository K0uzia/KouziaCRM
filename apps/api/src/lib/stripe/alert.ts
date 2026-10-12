import { getCompanySettings } from "@/lib/company.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";

/** Alerte e-mail à l'adresse de l'entreprise (événements Stripe à vérifier). */
export async function alertAdmin(subject: string, text: string): Promise<void> {
  const settings = await getCompanySettings();
  const to = settings.email?.trim();
  if (!to) {
    // Sans e-mail de l'entreprise (Réglages > Identité), l'alerte ne part pas : on la garde au journal.
    console.warn(`[stripe] alerte non envoyée (aucun e-mail d'entreprise) : ${subject}`);
    return;
  }
  await mailEnqueue({
    to,
    subject,
    text,
    kind: "stripe_alert",
    bodyTextForMessage: text,
  });
}
