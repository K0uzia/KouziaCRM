import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { createContact, syncPrimaryContact } from "@/lib/clients/contacts.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { isWeb3FormsSender } from "@/lib/email/web3forms.js";

/**
 * Fil d'un expéditeur sans client (demande d'Alexandre du 24/10/2026) : proposition de fiche (nom, entreprise) et
 * rattachement, sur action explicite seulement, de tous ses fils sans client.
 */

/** Messageries grand public : leur domaine n'est pas le nom d'une entreprise. */
const WEBMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr",
  "msn.com", "yahoo.com", "yahoo.fr", "icloud.com", "me.com", "mac.com", "orange.fr", "wanadoo.fr", "free.fr",
  "sfr.fr", "neuf.fr", "laposte.net", "bbox.fr", "aol.com", "aol.fr", "proton.me", "protonmail.com", "gmx.fr",
  "gmx.com", "gmx.de", "numericable.fr", "club-internet.fr",
]);

const capitalize = (w: string) => (w ? w.charAt(0).toLocaleUpperCase("fr") + w.slice(1) : w);

/** « Jean Dupont » ; sans nom affiché, « jean.dupont@… » ; sinon rien (jamais un nom inventé). */
export function splitSenderName(displayName: string | null | undefined, address: string): { firstName: string; lastName: string } {
  const name = (displayName ?? "").replace(/["']/g, "").trim();
  if (name && name.toLowerCase() !== address.toLowerCase() && !name.includes("@")) {
    const [first = "", ...rest] = name.split(/\s+/);
    return { firstName: first, lastName: rest.join(" ") };
  }
  const local = address.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter((p) => /^\p{L}+$/u.test(p));
  if (parts.length >= 2) return { firstName: capitalize(parts[0]!.toLowerCase()), lastName: parts.slice(1).map((p) => capitalize(p.toLowerCase())).join(" ") };
  return { firstName: "", lastName: "" };
}

/** Entreprise proposée depuis le domaine (« atelier-bois.fr » : « Atelier Bois ») ; null pour une messagerie grand public. */
export function companyFromDomain(address: string): string | null {
  const domain = address.split("@")[1]?.toLowerCase().trim();
  if (!domain || WEBMAIL_DOMAINS.has(domain)) return null;
  const labels = domain.split(".");
  const name = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
  const words = name.split(/[-_]+/).filter(Boolean).map(capitalize);
  return words.length ? words.join(" ") : null;
}

/** Dernier expéditeur reçu d'un fil (hors formulaire du site et envois de l'ERP vus comme reçus). */
async function lastInboundSender(threadId: string) {
  const messages = await prisma.emailMessage.findMany({
    where: { threadId, direction: EmailDirection.INBOUND, orphaned: false, NOT: { messageId: { endsWith: "@kouzia.local>" } } },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { fromAddress: true, fromName: true },
  });
  return messages.find((m) => m.fromAddress && !isWeb3FormsSender(m.fromAddress)) ?? null;
}

export type SenderSuggestion = {
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  /** Fiche qui porte déjà cette adresse (créée après le fil) : rattachement en un clic. */
  knownClient: { id: string; displayName: string } | null;
};

/** Fil sans client : expéditeur à rattacher ou à créer ; null si le fil a un client ou aucun message reçu. */
export async function senderSuggestionForThread(thread: { id: string; clientId: string | null }): Promise<SenderSuggestion | null> {
  if (thread.clientId) return null;
  const sender = await lastInboundSender(thread.id);
  if (!sender) return null;
  const email = sender.fromAddress.trim().toLowerCase();
  const knownId = await findClientIdByEmail(email);
  const known = knownId ? await prisma.client.findUnique({ where: { id: knownId }, select: { id: true, displayName: true } }) : null;
  return { email, ...splitSenderName(sender.fromName, email), company: companyFromDomain(email), knownClient: known };
}

export class SenderLinkError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * Rattache le fil et tous les fils sans client où cette adresse a écrit. Avec addContact, l'adresse devient un contact
 * du client (sauf si la fiche ou un contact la porte déjà) ; le contact principal est d'abord tiré de la fiche, pour
 * que l'expéditeur ne remplace jamais l'e-mail principal.
 */
export async function linkSenderToClient(threadId: string, clientId: string, opts: { addContact?: boolean } = {}) {
  const thread = await prisma.emailThread.findUnique({ where: { id: threadId }, select: { id: true } });
  if (!thread) throw new SenderLinkError("Fil introuvable", 404);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, emailHash: true } });
  if (!client) throw new SenderLinkError("Client introuvable", 404);
  const sender = await lastInboundSender(threadId);
  const email = sender?.fromAddress.trim().toLowerCase() ?? null;

  let contactAdded = false;
  if (opts.addContact && email) {
    const hash = computeEmailHash(email);
    const already =
      (hash && client.emailHash === hash) || (hash ? (await prisma.clientContact.count({ where: { clientId, emailHash: hash } })) > 0 : false);
    if (!already) {
      await syncPrimaryContact(clientId);
      const { firstName, lastName } = splitSenderName(sender?.fromName, email);
      await createContact(clientId, { firstName: firstName || null, lastName: lastName || null, role: null, email, phone: null });
      contactAdded = true;
    }
  }

  // Fils sans client où cette adresse a écrit (comparaison en minuscules : l'adresse est stockée telle que reçue).
  const ids = new Set<string>([threadId]);
  if (email) {
    const candidates = await prisma.emailMessage.findMany({
      where: { direction: EmailDirection.INBOUND, thread: { clientId: null } },
      select: { threadId: true, fromAddress: true },
    });
    for (const m of candidates) if (m.fromAddress.trim().toLowerCase() === email) ids.add(m.threadId);
  }
  const linked = await prisma.emailThread.updateMany({ where: { id: { in: [...ids] }, OR: [{ clientId: null }, { id: threadId }] }, data: { clientId } });
  return { client: { id: client.id, displayName: client.displayName }, linkedThreads: linked.count, contactAdded };
}
