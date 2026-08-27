export type EmailTemplateId =
  | "blank"
  | "invoice_reminder"
  | "quote_followup"
  | "subscription";

export type EmailTemplateVars = {
  clientName?: string;
  docNumber?: string;
};

export const EMAIL_TEMPLATES: Array<{
  id: EmailTemplateId;
  label: string;
}> = [
  { id: "blank", label: "Message libre" },
  { id: "invoice_reminder", label: "Relance facture" },
  { id: "quote_followup", label: "Suivi devis" },
  { id: "subscription", label: "Abonnement / maintenance" },
];

function greeting(name?: string) {
  return name ? `Bonjour ${name},` : "Bonjour,";
}

export function applyTemplate(
  id: EmailTemplateId,
  vars: EmailTemplateVars = {},
): { subject: string; body: string } {
  const name = vars.clientName?.trim();
  const doc = vars.docNumber?.trim();

  switch (id) {
    case "invoice_reminder":
      return {
        subject: doc ? `Relance facture ${doc}` : "Relance facture",
        body: `${greeting(name)}\n\nSauf erreur de notre part, la facture${doc ? ` ${doc}` : ""} reste en attente de règlement.\n\nMerci de nous indiquer si un document ou un RIB vous manque.\n\nCordialement,`,
      };
    case "quote_followup":
      return {
        subject: doc ? `Suivi devis ${doc}` : "Suivi de devis",
        body: `${greeting(name)}\n\nJe me permets de revenir vers vous concernant le devis${doc ? ` ${doc}` : ""} que je vous ai adressé.\n\nN'hésitez pas si vous avez des questions ou souhaitez en discuter.\n\nCordialement,`,
      };
    case "subscription":
      return {
        subject: "Abonnement / maintenance mensuelle",
        body: `${greeting(name)}\n\nConcernant votre abonnement de maintenance, voici les informations utiles.\n\nN'hésitez pas à me répondre pour toute question.\n\nCordialement,`,
      };
    case "blank":
    default:
      return {
        subject: "",
        body: `${greeting(name)}\n\n`,
      };
  }
}
