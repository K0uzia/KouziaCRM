import { EmailDirection, MailFolderRole, MailSenderRuleAction, MailSenderRuleKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { setMessageFlags } from "@/lib/email/sync/flag-sync.js";
import { moveMessageToFolder } from "@/lib/email/sync/folder-sync.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";
import {
  analyzeSuspicion,
  domainOf,
  isFreeMailDomain,
  suspicionBanner,
  type SuspicionSignal,
} from "@/lib/email/suspicion.js";
import { isWeb3FormsSender } from "@/lib/email/web3forms.js";
import {
  matchRule,
  recordRuleHit,
  ruleDomainFor,
  saveSenderRule,
  senderAddressOf,
  SenderRuleError,
} from "@/lib/email/sender-rules.js";

/** Dossier Indésirables (ou Réception) absent : rien n'est déplacé. */
export class SpamFolderError extends Error {}

/**
 * Mots-clés lus par les filtres anti-spam des serveurs (Dovecot, Fastmail, Thunderbird, Apple Mail), posés
 * en plus du déplacement pour que le fournisseur apprenne. Un serveur qui refuse les mots-clés libres
 * n'empêche pas le déplacement, qui suffit pour la plupart des boîtes (apprentissage au dépôt dans Junk).
 */
async function setJunkKeywords(
  message: { imapUid: number | null; folder: { imapPath: string } | null },
  junk: boolean,
): Promise<void> {
  if (!message.folder || !message.imapUid) return;
  const uid = String(message.imapUid);
  await withImapClient(async ({ client }) => {
    await client.mailboxOpen(message.folder!.imapPath);
    await client.messageFlagsAdd(uid, [junk ? "$Junk" : "$NotJunk"], { uid: true });
    await client.messageFlagsRemove(uid, [junk ? "$NotJunk" : "$Junk"], { uid: true });
  }).catch(() => undefined);
}

export type SpamMoveResult = {
  moved: number;
  kept: number;
  /** Dossier d'origine de chaque message déplacé, pour « Annuler ». */
  restore: Array<{ id: string; folderId: string }>;
};

async function moveAll(messageIds: string[], targetId: string, junk: boolean): Promise<SpamMoveResult> {
  const result: SpamMoveResult = { moved: 0, kept: 0, restore: [] };
  for (const id of new Set(messageIds)) {
    const message = await prisma.emailMessage.findUnique({ where: { id }, include: { folder: true } });
    if (!message || message.folderId === targetId) continue;
    // Un envoi de l'ERP n'est jamais signalé : seul un message reçu peut être indésirable.
    if (junk && message.direction === EmailDirection.OUTBOUND) continue;
    try {
      // Lu aussi sur le serveur (un message bloqué est importé lu en base, pas encore sur le serveur).
      if (junk) await setMessageFlags(message.id, { read: true });
      await setJunkKeywords(message, junk);
      await moveMessageToFolder(message.id, targetId);
      result.moved++;
      if (message.folderId) result.restore.push({ id: message.id, folderId: message.folderId });
    } catch {
      result.kept++;
    }
  }
  return result;
}

/** Signaler comme indésirable : le message part dans le dossier Indésirables du serveur, marqué lu. */
export async function reportSpam(messageIds: string[]): Promise<SpamMoveResult> {
  const junk = await prisma.mailFolder.findFirst({ where: { role: MailFolderRole.JUNK, isVirtual: false } });
  if (!junk) {
    throw new SpamFolderError(
      "Dossier Indésirables introuvable sur la boîte mail : indiquez-le dans Réglages, Messagerie.",
    );
  }
  return moveAll(messageIds, junk.id, true);
}

/** Messages d'expéditeurs bloqués, importés à l'instant : rangés dans Indésirables, compteur de la règle tenu. */
export async function applySenderBlocks(blocked: Array<{ messageId: string; ruleId: string }>): Promise<number> {
  if (blocked.length === 0) return 0;
  for (const b of blocked) await recordRuleHit(b.ruleId);
  const junk = await prisma.mailFolder.findFirst({ where: { role: MailFolderRole.JUNK, isVirtual: false } });
  // Sans dossier Indésirables : le message reste en Réception, déjà lu et sans notification.
  if (!junk) return 0;
  return (await moveAll(blocked.map((b) => b.messageId), junk.id, true)).moved;
}

/** Signaler et bloquer : une règle par expéditeur (adresse exacte), jamais pour un client. */
export async function blockSendersOf(messageIds: string[]): Promise<number> {
  const messages = await prisma.emailMessage.findMany({
    where: { id: { in: messageIds }, direction: EmailDirection.INBOUND },
    select: { fromAddress: true, replyToAddress: true },
  });
  let created = 0;
  for (const address of new Set(messages.map(senderAddressOf))) {
    try {
      await saveSenderRule({ kind: MailSenderRuleKind.ADDRESS, value: address, action: MailSenderRuleAction.BLOCK, source: "REPORT" });
      created++;
    } catch (err) {
      if (!(err instanceof SenderRuleError)) throw err;
    }
  }
  return created;
}

/** Pas un indésirable : le message revient dans la boîte de réception. */
export async function reportNotSpam(messageIds: string[]): Promise<SpamMoveResult> {
  const inbox = await prisma.mailFolder.findFirst({
    where: { role: MailFolderRole.INBOX, isVirtual: false },
    orderBy: { displayName: "asc" },
  });
  if (!inbox) throw new SpamFolderError("Boîte de réception introuvable : synchronisez la messagerie.");
  return moveAll(messageIds, inbox.id, false);
}

const DOMAINS_TTL_MS = 5 * 60 * 1000;
let domainsCache: { at: number; domains: string[] } | null = null;

/** Domaines de confiance : la boîte, les clients et les adresses déjà écrites (hors messageries gratuites). */
async function knownDomains(): Promise<string[]> {
  if (domainsCache && Date.now() - domainsCache.at < DOMAINS_TTL_MS) return domainsCache.domains;
  const [accounts, outbound, clients] = await Promise.all([
    prisma.mailAccount.findMany({ select: { email: true } }),
    prisma.emailMessage.findMany({
      where: { direction: EmailDirection.OUTBOUND },
      orderBy: { receivedAt: "desc" },
      take: 300,
      select: { toAddresses: true },
    }),
    prisma.client.findMany({
      where: { emailEncrypted: { not: null } },
      select: { emailEncrypted: true },
      take: 2000,
    }),
  ]);
  const set = new Set<string>();
  const add = (address: string | null | undefined) => {
    if (!address || !address.includes("@")) return;
    const d = domainOf(address);
    if (d && !isFreeMailDomain(d)) set.add(d);
  };
  for (const a of accounts) add(a.email);
  for (const m of outbound) {
    try {
      for (const to of JSON.parse(m.toAddresses || "[]") as string[]) add(to);
    } catch {
      /* liste illisible : ignorée */
    }
  }
  for (const c of clients) add(decryptOptional(c.emailEncrypted));
  domainsCache = { at: Date.now(), domains: [...set] };
  return domainsCache.domains;
}

export function resetKnownDomainsCache(): void {
  domainsCache = null;
}

export type MessageSecurity = {
  /** Signaux de la bannière (vide : pas de bannière). */
  signals: SuspicionSignal[];
  /** Images distantes chargées d'office : client, correspondant ou boîte elle-même, hors Indésirables. */
  remoteImagesAllowed: boolean;
  inJunk: boolean;
  /** Expéditeur visé par les boutons Bloquer / Faire confiance (absent pour un envoi de l'ERP). */
  sender?: {
    address: string;
    /** Domaine qu'une règle peut viser (null : messagerie grand public, domaine de l'entreprise). */
    domain: string | null;
    isClient: boolean;
    /** Adresse technique du formulaire sans Reply-To : ni blocage ni confiance possibles. */
    locked: boolean;
    rule: { id: string; kind: string; value: string; action: string } | null;
  };
};

/** Contrôles de sécurité d'un message, à l'ouverture : rien n'est enregistré. */
export async function messageSecurity(messageId: string, html: string | null): Promise<MessageSecurity> {
  const m = await prisma.emailMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      direction: true,
      fromAddress: true,
      fromName: true,
      replyToAddress: true,
      rawHeaders: true,
      folder: { select: { role: true } },
    },
  });
  if (!m) return { signals: [], remoteImagesAllowed: false, inJunk: false };
  const inJunk = m.folder?.role === MailFolderRole.JUNK;
  if (m.direction === EmailDirection.OUTBOUND) return { signals: [], remoteImagesAllowed: true, inJunk };

  // Formulaire du site : l'expéditeur réel est le prospect (Reply-To), Web3Forms n'est que le transport.
  const formSender = isWeb3FormsSender(m.fromAddress);
  const address = senderAddressOf(m);
  const [clientId, own, wroteTo, othersFrom, rules, domain] = await Promise.all([
    findClientIdByEmail(address),
    prisma.mailAccount.count({ where: { email: address } }),
    prisma.emailMessage.count({
      where: { direction: EmailDirection.OUTBOUND, toAddresses: { contains: `"${address}"` } },
    }),
    prisma.emailMessage.count({
      where: {
        id: { not: m.id },
        direction: EmailDirection.INBOUND,
        OR: [{ fromAddress: address }, { replyToAddress: address }],
      },
    }),
    prisma.mailSenderRule.findMany(),
    ruleDomainFor(address),
  ]);
  const rule = matchRule(rules, address);
  const trusted = rule?.action === MailSenderRuleAction.TRUST;
  const knownSender = Boolean(clientId) || own > 0 || wroteTo > 0 || trusted;
  const signals = suspicionBanner(
    analyzeSuspicion({
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      replyToAddress: m.replyToAddress,
      authHeaders: m.rawHeaders,
      html,
      knownSender,
      firstContact: wroteTo === 0 && othersFrom === 0,
      knownDomains: await knownDomains(),
      formSender,
    }),
  );
  return {
    signals,
    remoteImagesAllowed: (knownSender || formSender) && !inJunk && signals.length === 0,
    inJunk,
    sender: {
      address,
      domain,
      isClient: Boolean(clientId),
      locked: isWeb3FormsSender(address),
      rule: rule ? { id: rule.id, kind: rule.kind, value: rule.value, action: rule.action } : null,
    },
  };
}
