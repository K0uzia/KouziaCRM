import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { decryptOptional } from "@/lib/crypto.js";
import { MESSAGE_BODY_SELECT, messageBodyHtml, messageBodyText } from "@/lib/email/message-body.js";

/**
 * Formulaire du site relayé par Web3Forms (expéditeur notify+…@web3forms.com, « Site Kouzia ») :
 * corps « nom : … / email : … / telephone : … / structure : … / projet : … / message : … ».
 * Analyse écrite ici : le format est propre au formulaire de kouzia.com, aucune bibliothèque ne le couvre.
 */
export type FormLead = {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  project: string | null;
  message: string | null;
};

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Seul un message réellement émis par Web3Forms est analysé (domaine de l'expéditeur). */
export function isWeb3FormsSender(fromAddress: string | null | undefined): boolean {
  const domain = fromAddress?.trim().toLowerCase().split("@")[1];
  return domain === "web3forms.com" || Boolean(domain?.endsWith(".web3forms.com"));
}

function normalizeKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

const FIELD_BY_KEY: Record<string, keyof FormLead> = {
  nom: "name",
  name: "name",
  nomcomplet: "name",
  email: "email",
  mail: "email",
  courriel: "email",
  adresseemail: "email",
  telephone: "phone",
  tel: "phone",
  phone: "phone",
  structure: "company",
  entreprise: "company",
  societe: "company",
  organisation: "company",
  projet: "project",
  message: "message",
};

/** Corps HTML ou texte ramené à des lignes « clé : valeur » (cellules de tableau comprises). */
function toLines(body: string): string[] {
  const text = body
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " : ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  return text.split(/\r?\n/);
}

export function parseWeb3FormsBody(body: string | null | undefined): FormLead {
  const lead: FormLead = { name: null, email: null, phone: null, company: null, project: null, message: null };
  if (!body) return lead;
  let current: keyof FormLead | null = null;
  for (const line of toLines(body)) {
    const m = line.match(/^\s*([\p{L}][\p{L} _.-]{0,30}?)\s*:\s*(.*)$/u);
    const field = m ? FIELD_BY_KEY[normalizeKey(m[1]!)] : undefined;
    if (field) {
      current = field;
      const value = m![2]!.trim();
      if (lead[field] === null) lead[field] = value || null;
      continue;
    }
    // Message sur plusieurs lignes : la suite appartient au dernier champ « message ».
    if (current === "message" && line.trim()) lead.message = `${lead.message ? `${lead.message}\n` : ""}${line.trim()}`;
  }
  const email = lead.email?.replace(/^mailto:/i, "").trim().toLowerCase() ?? null;
  lead.email = email && EMAIL_RE.test(email) ? email : null;
  return lead;
}

/** Adresse du visiteur : Reply-To d'abord (si Web3Forms le renseigne), sinon la ligne « email : » du corps. */
export function formLeadEmail(opts: { replyToAddress: string | null; body: string | null }): string | null {
  const replyTo = opts.replyToAddress?.trim().toLowerCase();
  if (replyTo && EMAIL_RE.test(replyTo) && !isWeb3FormsSender(replyTo)) return replyTo;
  return parseWeb3FormsBody(opts.body).email;
}

type FormMessage = {
  id: string;
  threadId: string;
  fromAddress: string;
  replyToAddress: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyTextEncrypted: string | null;
  bodyHtmlEncrypted: string | null;
  subject: string;
  receivedAt: Date;
  isRead: boolean;
};

/**
 * Rattache un message du formulaire au client existant (recherche par emailHash, rien en clair dans
 * les journaux). Le fil commun aux formulaires (même objet) n'est jamais rattaché en bloc : un fil à
 * plusieurs messages cède ce message à un fil propre, au nom du client.
 */
export async function linkFormMessageToClient(message: FormMessage): Promise<string | null> {
  if (!isWeb3FormsSender(message.fromAddress)) return null;
  const email = formLeadEmail({ replyToAddress: message.replyToAddress, body: messageBodyText(message) ?? messageBodyHtml(message) });
  if (!email) return null;
  const clientId = await findClientIdByEmail(email);
  if (!clientId) return null;

  const others = await prisma.emailMessage.count({ where: { threadId: message.threadId, id: { not: message.id } } });
  if (others === 0) {
    await prisma.emailThread.update({ where: { id: message.threadId }, data: { clientId } });
    return clientId;
  }
  const thread = await prisma.emailThread.create({
    data: {
      subject: message.subject,
      participants: JSON.stringify([message.fromAddress, email]),
      clientId,
      lastMessageAt: message.receivedAt,
      unreadCount: message.isRead ? 0 : 1,
    },
  });
  await prisma.emailMessage.update({ where: { id: message.id }, data: { threadId: thread.id } });
  const unreadLeft = await prisma.emailMessage.count({ where: { threadId: message.threadId, isRead: false, orphaned: false } });
  const latest = await prisma.emailMessage.findFirst({ where: { threadId: message.threadId }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } });
  await prisma.emailThread.update({
    where: { id: message.threadId },
    data: { unreadCount: unreadLeft, ...(latest ? { lastMessageAt: latest.receivedAt } : {}) },
  });
  return clientId;
}

const FORM_SELECT = {
  id: true,
  threadId: true,
  fromAddress: true,
  replyToAddress: true,
  ...MESSAGE_BODY_SELECT,
  subject: true,
  receivedAt: true,
  isRead: true,
} as const;

/** Messages du formulaire encore sans client (corps à charger d'abord, `loadBody`) : rattachés si possible. */
export async function linkPendingFormMessages(loadBody: (messageId: string) => Promise<unknown>): Promise<number> {
  const where = {
    direction: EmailDirection.INBOUND,
    orphaned: false,
    fromAddress: { contains: "web3forms.com" },
    thread: { clientId: null },
  };
  const toFetch = await prisma.emailMessage.findMany({
    where: { ...where, bodyFetched: false, replyToAddress: null, imapUid: { not: null } },
    select: { id: true },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });
  for (const m of toFetch) {
    await loadBody(m.id).catch(() => undefined);
  }
  const candidates = await prisma.emailMessage.findMany({ where, select: FORM_SELECT, orderBy: { receivedAt: "desc" }, take: 200 });
  let linked = 0;
  for (const m of candidates) {
    if (await linkFormMessageToClient(m)) linked++;
  }
  return linked;
}

/**
 * Message ouvert dans la Messagerie : rattaché au client s'il existe ; sinon, fiche à préremplir pour
 * le bouton « Créer le client » (aucune création automatique). null hors formulaire ou déjà rattaché.
 */
export async function formLeadForMessage(messageId: string): Promise<Omit<FormLead, "project" | "message"> | null> {
  const m = await prisma.emailMessage.findUnique({
    where: { id: messageId },
    select: { ...FORM_SELECT, direction: true, thread: { select: { clientId: true } } },
  });
  if (!m || m.direction !== EmailDirection.INBOUND || !isWeb3FormsSender(m.fromAddress) || m.thread.clientId) return null;
  if (await linkFormMessageToClient(m)) return null;
  const lead = parseWeb3FormsBody(messageBodyText(m) ?? messageBodyHtml(m));
  const email = formLeadEmail({ replyToAddress: m.replyToAddress, body: messageBodyText(m) ?? messageBodyHtml(m) });
  if (!email && !lead.name) return null;
  return { name: lead.name, email, phone: lead.phone, company: lead.company };
}

export type FormSubmission = {
  messageId: string;
  receivedAt: Date;
  /** Champs du formulaire, pour une liste lisible (pas le texte brut). */
  fields: FormLead & { email: string | null };
  /** Client rattaché au message (fiche existante), sinon null : l'écran propose alors « Créer le client ». */
  client: { id: string; displayName: string } | null;
  /** Adresse de réponse : celle du client, sinon celle saisie dans le formulaire ; jamais l'expéditeur Web3Forms. */
  replyTo: string | null;
};

/**
 * Message du formulaire du site dans un fil (le plus récent) : champs analysés, client rattaché (rattachement
 * fait ici s'il manquait, sans effet s'il est déjà fait) et adresse de réponse. null si le fil n'en contient pas.
 * `loadBody` charge le corps s'il n'a pas encore été relevé.
 */
export async function formSubmissionForThread(
  threadId: string,
  loadBody: (messageId: string) => Promise<unknown>,
): Promise<FormSubmission | null> {
  const candidate = await prisma.emailMessage.findFirst({
    where: { threadId, direction: EmailDirection.INBOUND, orphaned: false, fromAddress: { contains: "web3forms.com" } },
    orderBy: { receivedAt: "desc" },
    select: { id: true, fromAddress: true, ...MESSAGE_BODY_SELECT },
  });
  if (!candidate || !isWeb3FormsSender(candidate.fromAddress)) return null;
  if (!messageBodyText(candidate) && !messageBodyHtml(candidate)) await loadBody(candidate.id).catch(() => undefined);
  await formLeadForMessage(candidate.id).catch(() => null);
  const m = await prisma.emailMessage.findUnique({
    where: { id: candidate.id },
    select: {
      id: true,
      receivedAt: true,
      replyToAddress: true,
      ...MESSAGE_BODY_SELECT,
      thread: { select: { client: { select: { id: true, displayName: true, emailEncrypted: true } } } },
    },
  });
  if (!m) return null;
  const body = messageBodyText(m) ?? messageBodyHtml(m);
  const lead = parseWeb3FormsBody(body);
  const email = formLeadEmail({ replyToAddress: m.replyToAddress, body });
  const client = m.thread.client;
  const clientEmail = client ? decryptOptional(client.emailEncrypted)?.trim().toLowerCase() || null : null;
  return {
    messageId: m.id,
    receivedAt: m.receivedAt,
    fields: { ...lead, email },
    client: client ? { id: client.id, displayName: client.displayName } : null,
    replyTo: clientEmail ?? email,
  };
}
