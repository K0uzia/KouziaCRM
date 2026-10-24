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
];

const BY_KEY = new Map(TEMPLATE_REGISTRY.map((t) => [t.key, t]));
export const templateDefinition = (key: string) => BY_KEY.get(key) ?? null;

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
    kept.push(line.replace(VARIABLE, (_m, n: string) => values[n] ?? ""));
  }
  const out: string[] = [];
  for (const line of kept.join("\n").split("\n")) {
    if (line.trim() === "" && (out.length === 0 || out[out.length - 1]!.trim() === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n");
}

/** Modèle modifié d'une clé, ou null : sans modification (ou modèle verrouillé), le code d'origine construit l'e-mail. */
export async function templateOverride(key: string): Promise<{ subject: string; body: string } | null> {
  const def = templateDefinition(key);
  if (!def || def.locked) return null;
  const row = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!row) return null;
  return { subject: row.subject ?? def.subject, body: row.body ?? def.body };
}
