import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/prisma.js";
import type { ReviewFamily } from "@/lib/email/review.js";

/**
 * Modèles d'e-mails modifiables (Réglages, décision du 25/10/2026). Le texte d'origine reste celui du code et figure
 * ici comme modèle d'origine, jamais perdu : la base (EmailTemplate) ne garde que les modifications, et un e-mail sans
 * modification est toujours construit par le code d'origine. Un modèle modifié ne s'applique qu'aux e-mails mis en
 * file ensuite. Corps en texte brut : signature, bouton de paiement et pied légal restent gérés par le système.
 */

export type TemplateVariable = { name: string; label: string; example: string };

export type TemplateDefinition = {
  key: string;
  family: ReviewFamily | null;
  label: string;
  recipient: "client" | "admin";
  /** Verrouillé : visible en lecture seule, jamais modifiable (codes, alertes, mise en demeure). */
  locked?: string;
  /** Rubrique de la liste quand elle diffère de la famille (« Accès et sécurité »). */
  section?: string;
  variables: TemplateVariable[];
  /** Variables que le corps doit garder (le serveur refuse un modèle qui les retire). */
  required: string[];
  subject: string;
  body: string;
};

const SALUTATION: TemplateVariable = { name: "salutation", label: "Salutation (« Bonjour Lou, » ou « Bonjour, »)", example: "Bonjour Lou," };
const PRENOM: TemplateVariable = { name: "prenom", label: "Prénom du client", example: "Lou" };
const CLIENT: TemplateVariable = { name: "client", label: "Nom du client", example: "Lou Martin" };
const NUMERO: TemplateVariable = { name: "numero", label: "Numéro du document", example: "F-2026-0042" };
const SUIVI: TemplateVariable = { name: "bloc_suivi", label: "Paragraphe de l'espace de suivi (lien compris)", example: "Vous pouvez retrouver cette facture et l'ensemble de vos documents sur votre espace de suivi : https://kouzia.com/suivi/" };
const PAIEMENT: TemplateVariable = { name: "lien_paiement", label: "Lien de paiement en ligne (ligne retirée sans lien)", example: "https://erp.kouzia.com/api/public/pay/abc" };
const DOCUMENT: TemplateVariable = { name: "document", label: "Nature du document (devis, facture, acompte)", example: "facture" };
const INFOS: TemplateVariable = { name: "informations", label: "Informations du rappel (jalon, étape, échéance ; retirées s'il n'y en a pas)", example: "Jalon : Acompte de 30 %\nÉchéance : 01/11/2026" };

const COMMON = [SALUTATION, PRENOM, CLIENT];
const MARQUE: TemplateVariable = { name: "marque", label: "Nom commercial", example: "Kouzia" };
const ABONNEMENT: TemplateVariable = { name: "abonnement", label: "Libellé de l'abonnement", example: "Site vitrine" };
const MONTANT: TemplateVariable = { name: "montant", label: "Montant", example: "30,00 €" };
const LIEN: TemplateVariable = { name: "lien", label: "Lien (paiement, gestion ou mise en place)", example: "https://erp.kouzia.com/api/public/manage/abc" };
const MENTION_FACTURE: TemplateVariable = { name: "mention_facture", label: "« (facture F-…) » s'il y a une facture, sinon vide", example: " (facture F-2026-0042)" };
const BLOC_ACCUSE: TemplateVariable = { name: "bloc_accuse", label: "Mention d'accusé de réception", example: "Cet e-mail vaut accusé de réception de votre demande. Conservez-le." };

export const TEMPLATE_REGISTRY: readonly TemplateDefinition[] = [
  {
    key: "document.quote",
    family: "document",
    label: "Envoi d'un devis",
    recipient: "client",
    variables: [...COMMON, NUMERO, SUIVI],
    required: ["numero"],
    subject: "Devis {{numero}}",
    body: "{{salutation}}\n\nVeuillez trouver ci-joint le devis {{numero}}.\nJe reste disponible pour en discuter.\n\n{{bloc_suivi}}",
  },
  {
    key: "document.invoice",
    family: "document",
    label: "Envoi d'une facture",
    recipient: "client",
    variables: [...COMMON, NUMERO, SUIVI, PAIEMENT],
    required: ["numero"],
    subject: "Facture {{numero}}",
    body: "{{salutation}}\n\nVeuillez trouver ci-joint la facture {{numero}}.\nMerci de procéder au règlement selon les conditions indiquées.\n\n{{bloc_suivi}}\n\nRégler en ligne : {{lien_paiement}}",
  },
  {
    key: "document.invoice_acompte",
    family: "document",
    label: "Envoi d'une facture d'acompte",
    recipient: "client",
    variables: [...COMMON, NUMERO, SUIVI, PAIEMENT],
    required: ["numero"],
    subject: "Facture d'acompte {{numero}}",
    body: "{{salutation}}\n\nVeuillez trouver ci-joint la facture d'acompte {{numero}}.\nMerci de procéder au règlement selon les conditions indiquées.\n\n{{bloc_suivi}}\n\nRégler en ligne : {{lien_paiement}}",
  },
  {
    key: "document.invoice_solde",
    family: "document",
    label: "Envoi d'une facture de solde",
    recipient: "client",
    variables: [...COMMON, NUMERO, SUIVI, PAIEMENT],
    required: ["numero"],
    subject: "Facture de solde {{numero}}",
    body: "{{salutation}}\n\nVeuillez trouver ci-joint la facture de solde {{numero}}.\nMerci de procéder au règlement selon les conditions indiquées.\n\n{{bloc_suivi}}\n\nRégler en ligne : {{lien_paiement}}",
  },
  {
    key: "document.credit_note",
    family: "document",
    label: "Envoi d'un avoir",
    recipient: "client",
    variables: [...COMMON, NUMERO],
    required: ["numero"],
    subject: "Avoir {{numero}}",
    body: "{{salutation}}\n\nVeuillez trouver ci-joint l'avoir {{numero}}.",
  },
  {
    key: "reminder.soft",
    family: "reminder",
    label: "Rappel courtois (devis, facture, acompte)",
    recipient: "client",
    variables: [...COMMON, DOCUMENT, NUMERO, INFOS, PAIEMENT],
    required: ["numero"],
    subject: "Rappel courtois : {{document}} {{numero}}",
    body: "{{salutation}}\n\nSauf erreur de notre part, le {{document}} {{numero}} reste en attente.\nN'hésitez pas si un RIB ou une précision vous manque.\n\n{{informations}}\n\nRégler en ligne : {{lien_paiement}}",
  },
  {
    key: "reminder.firm",
    family: "reminder",
    label: "Relance",
    recipient: "client",
    variables: [...COMMON, DOCUMENT, NUMERO, INFOS, PAIEMENT],
    required: ["numero"],
    subject: "Relance : {{document}} {{numero}}",
    body: "{{salutation}}\n\nJe me permets de revenir vers vous concernant le {{document}} {{numero}}, toujours en attente de règlement.\nMerci de me confirmer la date de virement prévue.\n\n{{informations}}\n\nRégler en ligne : {{lien_paiement}}",
  },
  {
    key: "reminder.formal",
    family: "formal_notice",
    label: "Mise en demeure",
    recipient: "client",
    locked: "Mise en demeure : texte verrouillé. La clause « pénalités de retard » se modifie dans Clauses.",
    variables: [...COMMON, DOCUMENT, NUMERO, PAIEMENT],
    required: ["numero"],
    subject: "Relance formelle : {{document}} {{numero}}",
    body: "{{salutation}}\n\nMalgré mes précédents rappels, le {{document}} {{numero}} demeure impayé.\nSans règlement sous huit jours, les conditions de retard de paiement suivantes pourront être appliquées : (clause des Réglages)\n\nRégler en ligne : {{lien_paiement}}",
  },
  // M3a (paiements, 26/10/2026).
  {
    key: "payment.receipt",
    family: "payment_receipt",
    label: "Reçu de paiement",
    recipient: "client",
    variables: [
      SALUTATION,
      NUMERO,
      { name: "montant", label: "Montant reçu", example: "450,00 €" },
      { name: "document", label: "Facture réglée (nature, numéro, devis)", example: "la facture d'acompte F-2026-0042 (devis D-2026-0012)" },
      { name: "facture_reglee", label: "« réglée » si la facture est soldée, sinon vide (objet)", example: "réglée" },
      { name: "etat_reglement", label: "Facture soldée ou reste à régler", example: "La facture est entièrement réglée." },
      { name: "pieces_jointes", label: "Pièces jointes (reçu et facture)", example: "Vous trouverez ci-joint le reçu de ce paiement et la facture F-2026-0042." },
      { name: "suite_projet", label: "Démarrage du projet (acompte soldé ; retiré sinon)", example: "Le projet démarre : je reviens vers vous très vite pour les prochaines étapes." },
    ],
    required: ["montant", "etat_reglement"],
    subject: "Paiement reçu : facture {{numero}} {{facture_reglee}}",
    body: "{{salutation}}\n\nNous avons bien reçu votre paiement de {{montant}} pour {{document}}. Merci !\n{{etat_reglement}} {{pieces_jointes}}\n\n{{suite_projet}}",
  },
  {
    key: "payment.deposit_link",
    family: "payment_link",
    label: "Lien de paiement d'un acompte ou du solde",
    recipient: "client",
    variables: [
      ...COMMON,
      { name: "devis", label: "Numéro du devis", example: "D-2026-0012" },
      { name: "echeance", label: "« l'acompte » ou « le solde »", example: "l'acompte" },
      { name: "montant", label: "Montant à régler", example: "450,00 €" },
      { name: "libelle_jalon", label: "Libellé de l'échéance", example: "Acompte" },
      { name: "lien_paiement", label: "Lien de paiement en ligne", example: "https://erp.kouzia.com/api/public/pay/abc" },
    ],
    required: ["montant", "lien_paiement"],
    subject: "Devis validé : réglez {{echeance}}",
    body: "{{salutation}}\n\nVotre devis {{devis}} est validé. Merci de régler {{echeance}} ({{montant}}).\n\nPayer en ligne : {{lien_paiement}}",
  },
  {
    key: "payment.deposit_paid",
    family: "payment_receipt",
    label: "Acompte reçu (avant sa facture)",
    recipient: "client",
    variables: [
      ...COMMON,
      { name: "devis", label: "Numéro du devis", example: "D-2026-0012" },
      { name: "nature", label: "« acompte » ou « solde »", example: "acompte" },
      { name: "montant", label: "Montant reçu", example: "450,00 €" },
    ],
    required: ["montant"],
    subject: "Paiement reçu : {{nature}} - devis {{devis}}",
    body: "{{salutation}}\n\nNous avons bien reçu votre paiement de {{montant}} ({{nature}} sur le devis {{devis}}).\nMerci pour votre confiance.",
  },
  {
    key: "payment.failed",
    family: "payment_issue",
    label: "Paiement non abouti (prélèvement refusé)",
    recipient: "client",
    variables: [
      SALUTATION,
      { name: "reference", label: "Référence (« devis D-… » ou numéro de facture)", example: "F-2026-0042" },
      { name: "paiement", label: "Paiement concerné", example: "Le paiement de la facture F-2026-0042" },
      { name: "montant", label: "Montant", example: "450,00 €" },
      {
        name: "bloc_reglement",
        label: "Moyens de régler (lien en ligne, IBAN et référence)",
        example: "Vous pouvez le régler à nouveau en ligne : https://erp.kouzia.com/api/public/pay/abc\n\nOu par virement sur l'IBAN FR76 …, en indiquant la référence F-2026-0042.",
      },
    ],
    required: ["montant", "bloc_reglement"],
    subject: "Paiement non abouti : {{reference}}",
    body: "{{salutation}}\n\n{{paiement}} ({{montant}}) n'a pas abouti.\n\n{{bloc_reglement}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  // M3b (abonnements, 26/10/2026). Les blocs « bloc_* » portent l'information due au client (échéance, date limite et
  // conséquences, accusé de réception, choix du rachat) : calculés par le système, obligatoires.
  {
    key: "subscription.setup",
    family: "payment_link",
    label: "Mise en place du prélèvement",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT, LIEN, { name: "moyens", label: "Moyens de prélèvement acceptés", example: "Prélèvement SEPA ou carte bancaire." }],
    required: ["lien"],
    subject: "Activer le prélèvement - {{abonnement}}",
    body: "{{salutation}}\n\nPour activer le prélèvement de votre abonnement « {{abonnement}} », cliquez sur le lien ci-dessous :\n\n{{lien}}\n\n{{moyens}}",
  },
  {
    key: "subscription.payment_failed",
    family: "payment_issue",
    label: "Prélèvement d'abonnement non abouti",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT, MONTANT, MENTION_FACTURE, { name: "suite", label: "Nouvelle tentative prévue ou régularisation", example: "Une nouvelle tentative aura lieu le 3 novembre 2026. Si votre moyen de paiement a changé, mettez-le à jour avant cette date :" }, LIEN],
    required: ["montant", "lien"],
    subject: "Prélèvement non abouti : {{abonnement}}",
    body: "{{salutation}}\n\nLe prélèvement de {{montant}} pour votre abonnement « {{abonnement}} »{{mention_facture}} n'a pas abouti.\n\n{{suite}}\n\n{{lien}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  {
    key: "subscription.payment_recovered",
    family: "payment_issue",
    label: "Prélèvement régularisé",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT, MONTANT, MENTION_FACTURE],
    required: ["montant"],
    subject: "Paiement reçu, merci : {{abonnement}}",
    body: "{{salutation}}\n\nLe paiement de {{montant}} pour votre abonnement « {{abonnement}} »{{mention_facture}} est bien arrivé : la situation est régularisée.\n\nVotre abonnement continue normalement. Merci !",
  },
  {
    key: "subscription.suspended",
    family: "payment_issue",
    label: "Abonnement suspendu faute de paiement",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT, LIEN],
    required: ["lien"],
    subject: "Abonnement suspendu faute de paiement : {{abonnement}}",
    body: "{{salutation}}\n\nMalgré les tentatives de prélèvement, une échéance de votre abonnement « {{abonnement}} » reste impayée. L'abonnement est suspendu jusqu'à son règlement.\n\nPour régulariser, réglez l'échéance ou changez de moyen de paiement :\n\n{{lien}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  {
    key: "subscription.action_required",
    family: "payment_issue",
    label: "Confirmation de paiement demandée par la banque",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT, MONTANT, MENTION_FACTURE, { name: "debut_objet", label: "« Confirmation » ou « Rappel : confirmation »", example: "Confirmation" }, LIEN],
    required: ["montant", "lien"],
    subject: "{{debut_objet}} de paiement requise : {{abonnement}}",
    body: "{{salutation}}\n\nVotre banque demande de confirmer le paiement de {{montant}} pour votre abonnement « {{abonnement}} »{{mention_facture}}.\n\nLe paiement ne sera fait qu'après votre confirmation, sur la page sécurisée de Stripe :\n\n{{lien}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  {
    key: "subscription.cancel_scheduled",
    family: "cancellation_ack",
    label: "Résiliation enregistrée (accusé)",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT, { name: "date_fin", label: "Date de fin", example: "31 décembre 2026" }, BLOC_ACCUSE],
    required: ["date_fin", "bloc_accuse"],
    subject: "Résiliation enregistrée : {{abonnement}}",
    body: "{{salutation}}\n\nNous avons bien enregistré la résiliation de votre abonnement « {{abonnement}} ».\n\nIl prendra fin le {{date_fin}} : aucun prélèvement ne sera fait après cette date.\n\n{{bloc_accuse}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  {
    key: "subscription.cancel_revoked",
    family: "cancellation_ack",
    label: "Résiliation annulée",
    recipient: "client",
    variables: [...COMMON, ABONNEMENT],
    required: ["abonnement"],
    subject: "Résiliation annulée : {{abonnement}}",
    body: "{{salutation}}\n\nLa résiliation de votre abonnement « {{abonnement}} » a été annulée : il continue normalement.\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  {
    key: "subscription.cancel_request",
    family: "cancellation_ack",
    label: "Demande de résiliation reçue (accusé)",
    recipient: "client",
    variables: [
      ...COMMON,
      ABONNEMENT,
      { name: "date_demande", label: "Date de la demande", example: "26 octobre 2026" },
      { name: "bloc_fin", label: "Date de fin et échéances encore dues (ou confirmation à venir)", example: "Votre abonnement prendra fin le 1 juin 2027, à la fin de votre engagement. Les échéances jusqu'à cette date restent dues. Rien ne change d'ici là." },
      BLOC_ACCUSE,
    ],
    required: ["date_demande", "bloc_fin", "bloc_accuse"],
    subject: "Demande de résiliation reçue : {{abonnement}}",
    body: "{{salutation}}\n\nNous avons bien reçu, le {{date_demande}}, votre demande de résiliation de l'abonnement « {{abonnement}} ».\n\n{{bloc_fin}}\n\n{{bloc_accuse}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  {
    key: "subscription.renewal",
    family: "subscription_notice",
    label: "Information de reconduction (abonnement annuel)",
    recipient: "client",
    variables: [
      ...COMMON,
      ABONNEMENT,
      MONTANT,
      { name: "date_reconduction", label: "Date de reconduction", example: "1 décembre 2026" },
      { name: "bloc_echeance", label: "Date limite, droit de refuser sans frais, démarche et conséquence", example: "Date limite pour refuser la reconduction : 30 novembre 2026\n\nVous pouvez refuser cette reconduction, sans frais et sans justification, jusqu'à cette date.\nIl vous suffit de répondre à cet e-mail.\n\nSans démarche de votre part, l'abonnement sera reconduit et une facture de 360,00 € vous sera adressée le 1 décembre 2026." },
    ],
    required: ["bloc_echeance"],
    subject: "Reconduction de votre abonnement annuel le {{date_reconduction}}",
    body: "{{salutation}}\n\nVotre abonnement annuel « {{abonnement}} » sera reconduit automatiquement le {{date_reconduction}}, pour un an, au prix de {{montant}}.\n\n{{bloc_echeance}}",
  },
  {
    key: "subscription.term_end",
    family: "subscription_notice",
    label: "Fin d'engagement ou d'année reconduite (abonnement engagé)",
    recipient: "client",
    variables: [
      ...COMMON,
      ABONNEMENT,
      { name: "objet_echeance", label: "« fin d'engagement le … » ou « reconduction le … »", example: "fin d'engagement le 1 juin 2027" },
      { name: "constat_echeance", label: "Fin de l'engagement ou de l'année en cours", example: "L'engagement de votre abonnement « Site vitrine » prend fin le 1 juin 2027." },
      { name: "bloc_echeance", label: "Reconduction tacite, date limite de préavis, droit de demander la non-reconduction", example: "Sans démarche de votre part, il sera reconduit pour un an au prix en vigueur (actuellement 30,00 € par mois).\n\nDate limite pour demander la non-reconduction : 1 mai 2027\n\nVous pouvez demander sa non-reconduction…" },
    ],
    required: ["bloc_echeance"],
    subject: "Votre abonnement « {{abonnement}} » : {{objet_echeance}}",
    body: "{{salutation}}\n\n{{constat_echeance}}\n{{bloc_echeance}}",
  },
  {
    key: "subscription.term_end_buyout",
    family: "subscription_notice",
    label: "Fin d'engagement avec rachat proposé",
    recipient: "client",
    variables: [
      ...COMMON,
      ABONNEMENT,
      { name: "date_fin", label: "Date de fin de l'engagement", example: "1 juin 2027" },
      { name: "bloc_choix", label: "Les trois choix (continuer, arrêter, racheter), prix et date limite compris", example: "Trois possibilités :\n- Continuer : …\n- Arrêter : …\n- Racheter votre site : …" },
      { name: "date_limite", label: "Date limite pour demander la non-reconduction", example: "Date limite pour demander la non-reconduction : 1 mai 2027" },
    ],
    required: ["bloc_choix", "date_limite"],
    subject: "Votre abonnement « {{abonnement}} » : fin d'engagement le {{date_fin}}",
    body: "{{salutation}}\n\nL'engagement de votre abonnement « {{abonnement}} » prend fin le {{date_fin}}.\n{{bloc_choix}}\n\n{{date_limite}}",
  },
  {
    key: "subscription.first_charge",
    family: "subscription_notice",
    label: "Avis de 1re échéance (démarrage différé)",
    recipient: "client",
    variables: [
      ...COMMON,
      ABONNEMENT,
      MONTANT,
      { name: "periode", label: "Périodicité (« par mois »)", example: "par mois" },
      { name: "date_echeance", label: "Date de la 1re échéance", example: "1 janvier 2027" },
      { name: "objet_echeance", label: "« 1er prélèvement le … » ou « 1re facture le … »", example: "1re facture le 1 janvier 2027" },
      { name: "bloc_echeance", label: "Date, montant prélevé ou facturé, et comment gérer ou ne pas poursuivre", example: "1re facture le 1 janvier 2027\n\nUne facture de 30,00 € vous sera adressée à cette date.\nPour toute question, ou pour ne pas poursuivre, répondez simplement à cet e-mail." },
    ],
    required: ["bloc_echeance"],
    subject: "Votre abonnement « {{abonnement}} » : {{objet_echeance}}",
    body: "{{salutation}}\n\nLa 1re échéance de votre abonnement « {{abonnement}} », de {{montant}} {{periode}}, aura lieu le {{date_echeance}}.\n\n{{bloc_echeance}}",
  },
  {
    key: "subscription.card_expiring",
    family: "subscription_notice",
    label: "Carte bientôt expirée",
    recipient: "client",
    variables: [
      ...COMMON,
      ABONNEMENT,
      { name: "carte", label: "Carte (marque et 4 derniers chiffres)", example: "VISA se terminant par 4242" },
      { name: "expiration", label: "Mois d'expiration", example: "11/2026" },
      LIEN,
    ],
    required: ["lien"],
    subject: "Votre carte expire bientôt : {{abonnement}}",
    body: "{{salutation}}\n\nLa carte {{carte}}, utilisée pour votre abonnement « {{abonnement}} », expire fin {{expiration}}.\n\nPour que les prochains prélèvements passent sans interruption, mettez-la à jour :\n\n{{lien}}\n\nUne question ? Répondez simplement à cet e-mail.",
  },
  // M3c (accès et divers, 26/10/2026).
  {
    key: "access.welcome",
    family: "portal_access",
    section: "Accès et sécurité",
    label: "Accès à l'espace client",
    recipient: "client",
    variables: [
      SALUTATION,
      MARQUE,
      { name: "lien", label: "Adresse de l'espace client", example: "https://kouzia.com/suivi/" },
      { name: "bloc_connexion", label: "Comment se connecter (adresse e-mail et code à usage unique)", example: "Saisissez votre adresse e-mail (lou@example.com) : vous recevez aussitôt un code à 6 chiffres. Aucun mot de passe à retenir." },
    ],
    required: ["lien", "bloc_connexion"],
    subject: "Votre espace client {{marque}}",
    body: "{{salutation}}\n\nVotre espace client est prêt. Vous y retrouvez vos devis, factures et paiements, et l'avancement de votre projet.\n\nPour y entrer : {{lien}}\n{{bloc_connexion}}",
  },
  {
    key: "onboarding.invite",
    family: "portal_access",
    section: "Accès et sécurité",
    label: "Invitation à compléter sa fiche client",
    recipient: "client",
    variables: [
      { name: "salutation", label: "Salutation (« Bonjour, » : le nom n'est pas encore connu)", example: "Bonjour," },
      MARQUE,
      { name: "objet_invitation", label: "« Complétez votre fiche client » ou « Mise à jour de votre fiche client »", example: "Complétez votre fiche client" },
      { name: "demande", label: "Demande (nouvelle fiche ou mise à jour)", example: "Pour me permettre de vous facturer dans les meilleures conditions, j'ai besoin de quelques informations vous concernant. Merci de prendre 2 minutes pour compléter votre fiche via le lien sécurisé ci-dessous :" },
      { name: "lien", label: "Lien personnel du formulaire", example: "https://kouzia.com/nouveau-client/?token=…" },
      { name: "bloc_validite", label: "Validité du lien et destination des données", example: "Ce lien est personnel et expire dans 14 jours. Vos données sont transmises directement à Kouzia et ne sont pas conservées sur le site public." },
    ],
    required: ["lien", "bloc_validite"],
    subject: "{{objet_invitation}} - {{marque}}",
    body: "{{salutation}}\n\n{{demande}}\n\n{{lien}}\n\n{{bloc_validite}}",
  },
  {
    key: "client.renewal",
    family: "subscription_notice",
    label: "Renouvellement chez l'hébergeur (domaine, hébergement)",
    recipient: "client",
    variables: [
      ...COMMON,
      { name: "prestation", label: "Ce qui se renouvelle", example: "kouzia.com" },
      { name: "chez", label: "« chez … » (hébergeur)", example: " chez OVHcloud" },
      { name: "date", label: "Date d'échéance", example: "1 décembre 2026" },
      { name: "date_rappel", label: "Date mise en avant", example: "Renouvellement le 1 décembre 2026" },
    ],
    required: ["date"],
    subject: "Pensez au renouvellement de « {{prestation}} » le {{date}}",
    body: "{{salutation}}\n\n« {{prestation}} » est à votre nom{{chez}} et arrive à échéance le {{date}}.\n\n{{date_rappel}}\n\nPensez à vérifier le renouvellement depuis votre compte, pour que votre site et vos adresses e-mail restent en ligne.\nPour toute question, répondez simplement à cet e-mail.",
  },
  // Verrouillés (lecture seule) : codes à usage unique et alerte de sécurité, jamais modifiables.
  {
    key: "access.login_code",
    family: null,
    section: "Accès et sécurité",
    label: "Code de connexion à l'espace client",
    recipient: "client",
    locked: "Code de connexion : texte verrouillé (sécurité de l'accès).",
    variables: [SALUTATION, MARQUE, { name: "code", label: "Code à 6 chiffres", example: "482913" }],
    required: [],
    subject: "{{code}} : votre code de connexion {{marque}}",
    body: "{{salutation}}\n\nVoici votre code de connexion à votre espace client {{marque}} :\n\n{{code}}\n\nIl est valable 15 minutes et ne sert qu'une fois. Une fois connecté, cet appareil est reconnu pendant 7 jours.\n\nVous n'avez rien demandé ? Ignorez cet e-mail : sans ce code, personne ne peut entrer dans votre espace.",
  },
  {
    key: "access.sign_code",
    family: null,
    section: "Accès et sécurité",
    label: "Code de signature d'un devis",
    recipient: "client",
    locked: "Code de signature : texte verrouillé (preuve de la signature).",
    variables: [SALUTATION, MARQUE, { name: "code", label: "Code à 6 chiffres", example: "482913" }, { name: "devis", label: "Devis", example: "le devis D-2026-0012" }],
    required: [],
    subject: "{{code}} : code de signature {{marque}}",
    body: "{{salutation}}\n\nVoici le code qui confirme votre signature pour {{devis}} :\n\n{{code}}\n\nIl est valable 15 minutes et ne sert qu'une fois.\n\nVous n'êtes pas en train de signer ce devis ? Ne communiquez ce code à personne et prévenez-moi en répondant à cet e-mail.",
  },
  {
    key: "access.new_device",
    family: null,
    section: "Accès et sécurité",
    label: "Alerte de connexion depuis un nouvel appareil",
    recipient: "client",
    locked: "Alerte de sécurité : texte verrouillé.",
    variables: [SALUTATION, MARQUE, { name: "appareil", label: "Appareil, date et heure", example: "Firefox sur Windows, le 26 octobre 2026 à 10:42." }],
    required: [],
    subject: "Nouvelle connexion à votre espace client {{marque}}",
    body: "{{salutation}}\n\nUne connexion à votre espace client {{marque}} vient d'avoir lieu depuis un nouvel appareil :\n\n{{appareil}}\n\nC'est vous ? Il n'y a rien à faire.\nCe n'est pas vous ? Répondez à cet e-mail : je déconnecte tous les appareils et nous vérifions ensemble l'accès à votre messagerie.",
  },
];

const BY_KEY = new Map(TEMPLATE_REGISTRY.map((t) => [t.key, t]));
export const templateDefinition = (key: string) => BY_KEY.get(key) ?? null;

/** Type technique d'un e-mail (EmailOutbox kind) et modèle qui en donne le texte ; absent : texte du code seul. */
const KIND_TEMPLATE: Record<string, string> = {
  quote: "document.quote",
  invoice: "document.invoice",
  invoice_acompte: "document.invoice_acompte",
  invoice_solde: "document.invoice_solde",
  credit_note: "document.credit_note",
  reminder_soft: "reminder.soft",
  reminder_firm: "reminder.firm",
  reminder_formal: "reminder.formal",
  deposit_checkout: "payment.deposit_link",
  payment_received: "payment.deposit_paid",
  payment_failed: "payment.failed",
  subscription_setup: "subscription.setup",
  subscription_payment_failed: "subscription.payment_failed",
  subscription_payment_recovered: "subscription.payment_recovered",
  subscription_suspended: "subscription.suspended",
  subscription_action_required: "subscription.action_required",
  subscription_action_reminder: "subscription.action_required",
  subscription_cancel_scheduled: "subscription.cancel_scheduled",
  subscription_cancel_revoked: "subscription.cancel_revoked",
  subscription_cancel_request: "subscription.cancel_request",
  subscription_renewal: "subscription.renewal",
  subscription_term_end: "subscription.term_end",
  subscription_term_end_buyout: "subscription.term_end_buyout",
  subscription_first_charge: "subscription.first_charge",
  subscription_card_expiring: "subscription.card_expiring",
  access: "access.welcome",
  onboarding: "onboarding.invite",
  client_renewal: "client.renewal",
  portal_alert: "access.new_device",
};

/**
 * Modèle d'un e-mail d'après son type et sa famille de validation (« Modifier le modèle ») ; null s'il n'en a pas. Le reçu
 * de paiement part sous le type de sa facture : la famille le distingue ; une confirmation de signature n'a pas de modèle.
 */
export function templateKeyFor(kind: string | null | undefined, family?: string | null): string | null {
  if (family === "signature_confirmation" || family === "subscription_invoice" || family === "review_invite") return null;
  if (family === "payment_receipt" && kind !== "payment_received") return "payment.receipt";
  return (kind && KIND_TEMPLATE[kind]) || null;
}

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Variables citées dans un texte (« {{numero}} »). */
export function variablesIn(text: string): string[] {
  return [...text.matchAll(VARIABLE)].map((m) => m[1]!);
}

export type TemplateIssue = { field: "subject" | "body"; code: "unknown_variable" | "missing_required" | "locked" | "empty"; variable?: string; message: string };

/** Contrôle d'un modèle modifié : verrou, variables inconnues, variables obligatoires retirées, champs vides. */
export function validateTemplate(key: string, subject: string, body: string): TemplateIssue[] {
  const def = templateDefinition(key);
  if (!def) return [{ field: "body", code: "unknown_variable", message: "Modèle inconnu." }];
  if (def.locked) return [{ field: "body", code: "locked", message: def.locked }];
  const issues: TemplateIssue[] = [];
  const known = new Set(def.variables.map((v) => v.name));
  for (const [field, text] of [["subject", subject], ["body", body]] as const) {
    if (!text.trim()) issues.push({ field, code: "empty", message: field === "subject" ? "L'objet est vide." : "Le texte est vide." });
    for (const name of new Set(variablesIn(text))) {
      if (!known.has(name)) issues.push({ field, code: "unknown_variable", variable: name, message: `Variable inconnue : {{${name}}}.` });
    }
  }
  const used = new Set([...variablesIn(subject), ...variablesIn(body)]);
  for (const name of def.required) {
    if (!used.has(name)) issues.push({ field: "body", code: "missing_required", variable: name, message: `La variable {{${name}}} est obligatoire dans ce modèle.` });
  }
  return issues;
}

/**
 * Remplit un modèle. Une ligne dont toutes les variables sont vides disparaît (« Régler en ligne : » sans lien) ; les
 * lignes vides en double et en fin de texte sont resserrées, comme le texte du code.
 */
export function fillTemplate(text: string, values: Record<string, string | null | undefined>): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const names = variablesIn(line);
    if (names.length > 0 && names.every((n) => !values[n]?.trim())) continue;
    // Espaces de fin retirés : une variable facultative vide en fin de ligne (« réglée ») ne laisse pas d'espace.
    kept.push(line.replace(VARIABLE, (_m, n: string) => values[n] ?? "").replace(/[ \t]+$/, ""));
  }
  const out: string[] = [];
  for (const line of kept.join("\n").split("\n")) {
    if (line.trim() === "" && (out.length === 0 || out[out.length - 1]!.trim() === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n");
}

/**
 * Objet et texte (sans signature) d'un e-mail : le modèle modifié rempli avec ses variables, sinon le texte du code,
 * inchangé. La signature et la mise en page restent à l'appelant.
 */
export async function templateText(
  key: string,
  values: Record<string, string | null | undefined>,
  original: { subject: string; body: string },
): Promise<{ subject: string; body: string }> {
  const override = await templateOverride(key);
  return override ? { subject: fillTemplate(override.subject, values), body: fillTemplate(override.body, values) } : original;
}

/** Aperçu (M3c) : texte en cours de saisie, utilisé à la place de la base le temps d'un rendu, sans rien enregistrer. */
const draftStore = new AsyncLocalStorage<Map<string, { subject: string; body: string }>>();

/** Exécute un rendu avec ce modèle en cours de saisie, comme s'il était enregistré (aperçu avec de vraies données). */
export function withDraftTemplate<T>(key: string, draft: { subject: string; body: string }, run: () => Promise<T>): Promise<T> {
  return draftStore.run(new Map([[key, draft]]), run);
}

/** Modèle modifié d'une clé, ou null : sans modification (ou modèle verrouillé), le code d'origine construit l'e-mail. */
export async function templateOverride(key: string): Promise<{ subject: string; body: string } | null> {
  const def = templateDefinition(key);
  if (!def || def.locked) return null;
  const draft = draftStore.getStore()?.get(key);
  if (draft) return draft;
  const row = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!row) return null;
  return { subject: row.subject ?? def.subject, body: row.body ?? def.body };
}
