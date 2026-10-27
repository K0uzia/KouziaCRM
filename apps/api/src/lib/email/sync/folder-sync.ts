import {
  EmailDirection,
  MailFolderRole,
  type MailFolder,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import { isOwnOutboundMessage, readOutboundHeader } from "@/lib/email/own-messages.js";
import {
  buildFolderOverrides,
  detectFolderRole,
  folderDisplayName,
} from "@/lib/email/sync/folder-mapper.js";
import { hasImapFlag, toImapInt, toUidValidity } from "@/lib/email/sync/imap-int.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";
import { ensureMailAccount } from "@/lib/email/sync/sync-status.js";
import { normalizeSubject, parseAddressList } from "@/lib/email/sync/threading.js";
import { isWeb3FormsSender } from "@/lib/email/web3forms.js";
import type { ImapFlow } from "imapflow";

type EnvelopeLike = {
  messageId?: string;
  inReplyTo?: string;
  subject?: string;
  date?: Date;
  from?: Array<{ address?: string; name?: string }>;
  replyTo?: Array<{ address?: string; name?: string }>;
  to?: Array<{ address?: string; name?: string }>;
  cc?: Array<{ address?: string; name?: string }>;
};

function envelopeFrom(raw: unknown): EnvelopeLike {
  if (!raw || typeof raw !== "object") return {};
  return raw as EnvelopeLike;
}

/**
 * Vrai PJ IMAP : disposition attachment / filename.
 * Un multipart text+html a des childNodes mais PAS de pièce jointe.
 */
function bodyStructureHasRealAttachment(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as {
    type?: string;
    disposition?: string | { type?: string } | null;
    dispositionParameters?: { filename?: string } | null;
    parameters?: { name?: string } | null;
    childNodes?: unknown[];
  };
  const disposition =
    typeof n.disposition === "string"
      ? n.disposition.toLowerCase()
      : n.disposition?.type?.toLowerCase();
  if (disposition === "attachment") return true;
  if (n.dispositionParameters?.filename) return true;

  const type = (n.type ?? "").toLowerCase();
  const named = Boolean(n.parameters?.name);
  // Partie binaire/fichier nommée (PDF, zip…), hors text/multipart/message
  if (
    named &&
    type &&
    type !== "multipart" &&
    type !== "text" &&
    type !== "message"
  ) {
    return true;
  }
  if (type === "application" && named) return true;

  if (Array.isArray(n.childNodes)) {
    return n.childNodes.some(bodyStructureHasRealAttachment);
  }
  return false;
}

/** Certains serveurs (ex. Dovecot) renvoient BAD sur FETCH si la plage UID est vide. */
function hasUidRange(mailbox: { uidNext?: bigint | number | null; exists?: number }, fromUid: number): boolean {
  if ((mailbox.exists ?? 0) === 0) return false;
  const uidNext = toImapInt(mailbox.uidNext);
  if (uidNext > 0 && fromUid >= uidNext) return false;
  return fromUid > 0;
}

async function reconcileOrphanedMessages(folderId: string, client: ImapFlow): Promise<number> {
  const orphaned = await prisma.emailMessage.findMany({
    where: { folderId, orphaned: true, imapUid: { not: null } },
    select: { id: true, imapUid: true },
  });
  if (orphaned.length === 0) return 0;

  const uidSet = orphaned
    .map((m) => toImapInt(m.imapUid))
    .filter((uid) => uid > 0)
    .join(",");
  if (!uidSet) return 0;

  let reconciled = 0;
  for await (const msg of client.fetch(uidSet, { uid: true, flags: true }, { uid: true })) {
    const uid = toImapInt(msg.uid);
    if (!uid) continue;
    const existing = orphaned.find((m) => toImapInt(m.imapUid) === uid);
    if (!existing) continue;
    const isRead = hasImapFlag(msg.flags, "Seen");
    const isStarred = hasImapFlag(msg.flags, "Flagged");
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: { isRead, isStarred, orphaned: false },
    });
    reconciled++;
  }
  return reconciled;
}

function messageIdFromEnvelope(env: EnvelopeLike, uid: number, path: string): string {
  return env.messageId?.trim() || `uid-${path}-${uid}@local`;
}

async function resolveThreadId(opts: {
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  participants: string[];
  clientId: string | null;
  receivedAt: Date;
  /** Faux pour le formulaire du site : tous ses messages ont le même objet, chacun garde son fil. */
  mergeBySubject?: boolean;
}): Promise<string> {
  if (opts.inReplyTo) {
    const parent = await prisma.emailMessage.findUnique({
      where: { messageId: opts.inReplyTo },
      select: { threadId: true },
    });
    if (parent) return parent.threadId;
  }

  if (opts.references) {
    const refs = opts.references.split(/\s+/).filter(Boolean);
    for (const ref of refs.reverse()) {
      const parent = await prisma.emailMessage.findUnique({
        where: { messageId: ref },
        select: { threadId: true },
      });
      if (parent) return parent.threadId;
    }
  }

  const normalized = normalizeSubject(opts.subject);
  const recent =
    opts.mergeBySubject === false
      ? []
      : await prisma.emailThread.findMany({
          take: 100,
          orderBy: { lastMessageAt: "desc" },
        });
  const match = recent.find((t) => normalizeSubject(t.subject) === normalized);
  if (match) {
    await prisma.emailThread.update({
      where: { id: match.id },
      data: {
        lastMessageAt: opts.receivedAt,
        clientId: match.clientId ?? opts.clientId,
        participants: JSON.stringify(
          Array.from(
            new Set([...JSON.parse(match.participants || "[]"), ...opts.participants]),
          ),
        ),
      },
    });
    return match.id;
  }

  const thread = await prisma.emailThread.create({
    data: {
      subject: opts.subject || "(sans objet)",
      participants: JSON.stringify(opts.participants),
      clientId: opts.clientId,
      lastMessageAt: opts.receivedAt,
      unreadCount: 0,
    },
  });
  return thread.id;
}

async function upsertFolderFromServer(opts: {
  accountId: string;
  imapPath: string;
  role: MailFolderRole;
}): Promise<MailFolder> {
  return prisma.mailFolder.upsert({
    where: {
      accountId_imapPath: {
        accountId: opts.accountId,
        imapPath: opts.imapPath,
      },
    },
    create: {
      accountId: opts.accountId,
      imapPath: opts.imapPath,
      displayName: folderDisplayName(opts.imapPath, opts.role),
      role: opts.role,
    },
    update: {
      displayName: folderDisplayName(opts.imapPath, opts.role),
      role: opts.role,
    },
  });
}

export async function discoverAndEnsureFolders(): Promise<MailFolder[]> {
  const account = await ensureMailAccount();
  const settings = await getCompanySettings();
  const overrides = buildFolderOverrides(settings);

  return withImapClient(async ({ client }) => {
    const listed = await client.list();
    const paths = listed.map((m) => m.path).filter(Boolean);
    const folders: MailFolder[] = [];

    const forcedPaths = new Set<string>();
    for (const path of Object.values(overrides)) {
      if (path) forcedPaths.add(path);
    }
    if (forcedPaths.size === 0 && !paths.includes("INBOX")) {
      paths.unshift("INBOX");
    }

    const specialUseByPath = new Map(listed.map((m) => [m.path, m.specialUse ?? null]));
    const allPaths = Array.from(new Set([...paths, ...forcedPaths]));
    for (const imapPath of allPaths) {
      if (!imapPath) continue;
      const role = detectFolderRole(imapPath, overrides, specialUseByPath.get(imapPath));
      folders.push(await upsertFolderFromServer({ accountId: account.id, imapPath, role }));
    }

    return folders;
  });
}

export async function syncFolder(folderId: string): Promise<{ imported: number; updated: number }> {
  const folder = await prisma.mailFolder.findUniqueOrThrow({ where: { id: folderId } });
  if (folder.isVirtual) return { imported: 0, updated: 0 };

  let imported = 0;
  let updated = 0;

  await withImapClient(async ({ client }) => {
    const mailbox = await client.mailboxOpen(folder.imapPath);
    const uidValidity = toUidValidity(mailbox.uidValidity);

    if (folder.uidValidity > 0 && folder.uidValidity !== uidValidity) {
      await prisma.mailFolder.update({
        where: { id: folder.id },
        data: { uidValidity, highestUid: 0 },
      });
      await prisma.emailMessage.updateMany({
        where: { folderId: folder.id },
        data: { orphaned: true },
      });
      folder.highestUid = 0;
      folder.uidValidity = uidValidity;
    }

    const startUid = folder.highestUid > 0 ? folder.highestUid + 1 : 1;
    let maxUid = folder.highestUid;
    let folderUnread = 0;

    if (hasUidRange(mailbox, startUid)) {
      for await (const msg of client.fetch(
        `${startUid}:*`,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          size: true,
          headers: ["x-kouzia-outbound"],
        },
        { uid: true },
      )) {
        const uid = toImapInt(msg.uid);
        if (!uid) continue;
        if (uid < startUid) continue;

        const env = envelopeFrom(msg.envelope);
        const mid = messageIdFromEnvelope(env, uid, folder.imapPath);
        const fromAddress =
          env.from?.[0]?.address?.toLowerCase() ||
          env.from?.[0]?.name?.toLowerCase() ||
          "unknown";
        const fromName = env.from?.[0]?.name?.trim() || null;
        const replyToRaw = env.replyTo?.[0]?.address?.trim().toLowerCase() || null;
        const replyToAddress = replyToRaw && replyToRaw !== fromAddress ? replyToRaw : null;
        const toAddresses = parseAddressList(env.to);
        const ccAddresses = parseAddressList(env.cc);
        const subject = env.subject || "(sans objet)";
        const inReplyTo = env.inReplyTo?.trim() || null;
        const receivedAt = env.date || new Date();
        const isRead = hasImapFlag(msg.flags, "Seen");
        const isStarred = hasImapFlag(msg.flags, "Flagged");
        const hasAttachments = bodyStructureHasRealAttachment(msg.bodyStructure);

        const existing = await prisma.emailMessage.findFirst({
          where: { folderId: folder.id, imapUid: uid },
        });

        if (existing) {
          const mergedRead = readFromServer(existing, isRead);
          const mergedStarred = existing.flagsPending ? existing.isStarred : isStarred;
          if (
            existing.isRead !== mergedRead ||
            existing.isStarred !== mergedStarred ||
            existing.orphaned ||
            (!existing.bodyFetched && existing.hasAttachments !== hasAttachments)
          ) {
            await prisma.emailMessage.update({
              where: { id: existing.id },
              data: {
                isRead: mergedRead,
                isStarred: mergedStarred,
                orphaned: false,
                ...(!existing.bodyFetched ? { hasAttachments } : {}),
              },
            });
            updated++;
          }
          maxUid = Math.max(maxUid, uid);
          if (!mergedRead) folderUnread++;
          continue;
        }

        const byMessageId = await prisma.emailMessage.findUnique({ where: { messageId: mid } });
        if (byMessageId) {
          // Déplacé côté serveur (nouveau dossier, nouvel uid) : suivi au lieu d'être dupliqué.
          const movedRead = readFromServer(byMessageId, isRead);
          await prisma.emailMessage.update({
            where: { id: byMessageId.id },
            data: {
              folderId: folder.id,
              imapUid: uid,
              isRead: movedRead,
              isStarred: byMessageId.flagsPending ? byMessageId.isStarred : isStarred,
              orphaned: false,
            },
          });
          maxUid = Math.max(maxUid, uid);
          if (!movedRead) folderUnread++;
          updated++;
          continue;
        }

        // Envoi de l'ERP retrouvé hors du dossier Envoyés (copie, alerte à soi-même) : pas un message reçu,
        // donc ni notification « nouvel e-mail » ni non lu.
        const ownOutbound = isOwnOutboundMessage({ messageId: mid, outboundHeader: readOutboundHeader(msg.headers) });
        const direction =
          folder.role === MailFolderRole.SENT || ownOutbound ? EmailDirection.OUTBOUND : EmailDirection.INBOUND;
        // Un envoi de l'ERP n'est jamais « non lu », même retrouvé dans la boîte de réception.
        const readNow = isRead || ownOutbound;
        const inboundReplyTo = direction === EmailDirection.INBOUND ? replyToAddress : null;
        const participants = Array.from(
          new Set([fromAddress, ...(inboundReplyTo ? [inboundReplyTo] : []), ...toAddresses, ...ccAddresses]),
        );
        // Formulaire du site (Web3Forms) : le prospect est dans Reply-To, pas dans From.
        const clientId =
          direction === EmailDirection.OUTBOUND
            ? await findClientIdByEmail(toAddresses[0] ?? fromAddress)
            : ((inboundReplyTo ? await findClientIdByEmail(inboundReplyTo) : null) ??
              (await findClientIdByEmail(fromAddress)));

        const threadId = await resolveThreadId({
          messageId: mid,
          inReplyTo,
          references: null,
          subject,
          participants,
          clientId,
          receivedAt,
          mergeBySubject: !(direction === EmailDirection.INBOUND && isWeb3FormsSender(fromAddress)),
        });

        await prisma.emailMessage.create({
          data: {
            threadId,
            folderId: folder.id,
            direction,
            messageId: mid,
            inReplyTo,
            fromAddress,
            fromName,
            replyToAddress: inboundReplyTo,
            toAddresses: JSON.stringify(toAddresses),
            ccAddresses: ccAddresses.length ? JSON.stringify(ccAddresses) : null,
            subject,
            snippet: subject.slice(0, 120),
            receivedAt,
            isRead: readNow,
            isStarred,
            hasAttachments,
            imapUid: uid,
            bodyFetched: false,
          },
        });

        if (!readNow) {
          await prisma.emailThread.update({
            where: { id: threadId },
            data: { unreadCount: { increment: 1 } },
          });
        }

        imported++;
        maxUid = Math.max(maxUid, uid);
        if (!readNow) folderUnread++;
      }
    }

    updated += await reconcileOrphanedMessages(folder.id, client);
    updated += await orphanUidsMissingOnServer(folder.id, client, mailbox.exists ?? 0);
    updated += await repairAttachmentFlagsForFolder(folder.id, client);

    if (startUid === 1 && maxUid === folder.highestUid) {
      const status = await client.status(folder.imapPath, { unseen: true });
      folderUnread = toImapInt(status.unseen) || folderUnread;
    } else if (!hasUidRange(mailbox, startUid)) {
      const status = await client.status(folder.imapPath, { unseen: true });
      folderUnread = toImapInt(status.unseen) || folderUnread;
    }

    const unreadLocal = await countUnreadInFolder(folder.id);

    await prisma.mailFolder.update({
      where: { id: folder.id },
      data: {
        uidValidity,
        highestUid: toImapInt(maxUid),
        unreadCount: unreadLocal,
        lastSyncedAt: new Date(),
      },
    });
  });

  return { imported, updated };
}

/**
 * État lu à retenir pour un message déjà connu : le serveur fait foi (lu ou remis non lu dans un autre
 * client), sauf changement fait dans l'ERP et pas encore écrit sur le serveur. Un envoi de l'ERP
 * n'est jamais compté non lu, même si sa copie IMAP n'a pas \Seen.
 */
function readFromServer(
  local: { isRead: boolean; flagsPending: boolean; direction: EmailDirection },
  serverSeen: boolean,
): boolean {
  if (local.flagsPending) return local.isRead;
  return serverSeen || local.direction === EmailDirection.OUTBOUND;
}

/** Écrit sur le serveur les drapeaux changés dans l'ERP dont l'écriture IMAP immédiate a échoué. */
async function pushPendingFlags(folderId: string, client: ImapFlow): Promise<number> {
  const pending = await prisma.emailMessage.findMany({
    where: { folderId, flagsPending: true, orphaned: false, imapUid: { not: null } },
    select: { id: true, imapUid: true, isRead: true, isStarred: true },
  });
  for (const m of pending) {
    const uid = String(m.imapUid);
    if (m.isRead) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
    if (m.isStarred) await client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
    else await client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true });
    // Rien n'a changé dans l'ERP pendant l'écriture : l'état est aligné.
    await prisma.emailMessage.updateMany({
      where: { id: m.id, flagsPending: true, isRead: m.isRead, isStarred: m.isStarred },
      data: { flagsPending: false },
    });
  }
  return pending.length;
}

/** Masque les copies locales absentes du serveur IMAP (ex. restes Mailpit). */
async function orphanUidsMissingOnServer(
  folderId: string,
  client: ImapFlow,
  exists: number,
): Promise<number> {
  const serverUids: number[] = [];
  if (exists > 0) {
    try {
      for await (const msg of client.fetch("1:*", { uid: true }, { uid: true })) {
        const uid = toImapInt(msg.uid);
        if (uid > 0) serverUids.push(uid);
      }
    } catch {
      return 0;
    }
  }

  const result = await prisma.emailMessage.updateMany({
    where: {
      folderId,
      orphaned: false,
      imapUid: serverUids.length > 0 ? { notIn: serverUids } : { not: null },
    },
    data: { orphaned: true },
  });
  return result.count;
}

/** Corrige les faux positifs PJ (multipart texte sans fichier). */
async function repairAttachmentFlagsForFolder(
  folderId: string,
  client: ImapFlow,
): Promise<number> {
  let fixed = 0;

  const cleared = await prisma.emailMessage.updateMany({
    where: {
      folderId,
      bodyFetched: true,
      hasAttachments: true,
      attachments: { none: {} },
    },
    data: { hasAttachments: false },
  });
  fixed += cleared.count;

  const suspects = await prisma.emailMessage.findMany({
    where: {
      folderId,
      hasAttachments: true,
      bodyFetched: false,
      orphaned: false,
      imapUid: { not: null },
    },
    select: { id: true, imapUid: true },
    take: 300,
  });
  if (suspects.length === 0) return fixed;

  const byUid = new Map(suspects.map((s) => [s.imapUid!, s.id]));
  const uidQuery = suspects.map((s) => s.imapUid!).join(",");
  for await (const msg of client.fetch(uidQuery, { uid: true, bodyStructure: true }, { uid: true })) {
    const uid = toImapInt(msg.uid);
    const id = byUid.get(uid);
    if (!id) continue;
    if (!bodyStructureHasRealAttachment(msg.bodyStructure)) {
      await prisma.emailMessage.update({
        where: { id },
        data: { hasAttachments: false },
      });
      fixed++;
    }
  }
  return fixed;
}

export async function syncAllFolders(): Promise<{
  imported: number;
  updated: number;
  folders: number;
}> {
  const folders = await discoverAndEnsureFolders();
  let imported = 0;
  let updated = 0;

  for (const folder of folders.filter((f) => !f.isVirtual)) {
    const result = await syncFolder(folder.id);
    imported += result.imported;
    updated += result.updated;
  }

  return { imported, updated, folders: folders.length };
}

export async function pollFlagChanges(folderId: string): Promise<number> {
  const folder = await prisma.mailFolder.findUniqueOrThrow({ where: { id: folderId } });
  if (folder.isVirtual || folder.highestUid <= 0) return 0;

  const select = { id: true, imapUid: true, isRead: true, isStarred: true, direction: true, flagsPending: true } as const;
  const base = { folderId: folder.id, imapUid: { not: null }, orphaned: false };
  // Les 200 plus récents, plus tous les non lus : un ancien message lu ailleurs sort aussi du compteur.
  const [recent, unread] = await Promise.all([
    prisma.emailMessage.findMany({ where: base, select, orderBy: { imapUid: "desc" }, take: 200 }),
    prisma.emailMessage.findMany({ where: { ...base, isRead: false }, select }),
  ]);
  const tracked = [...new Map([...recent, ...unread].map((m) => [m.id, m])).values()];

  if (tracked.length === 0) return 0;

  let changed = 0;

  await withImapClient(async ({ client }) => {
    await client.mailboxOpen(folder.imapPath);
    changed += await pushPendingFlags(folder.id, client);
    const uidSet = tracked
      .filter((m) => !m.flagsPending)
      .map((m) => m.imapUid)
      .filter((uid): uid is number => typeof uid === "number" && uid > 0)
      .join(",");

    if (!uidSet) return;

    for await (const msg of client.fetch(uidSet, { uid: true, flags: true }, { uid: true })) {
      const uid = toImapInt(msg.uid);
      if (!uid) continue;
      const isRead = hasImapFlag(msg.flags, "Seen");
      const isStarred = hasImapFlag(msg.flags, "Flagged");
      const existing = tracked.find((m) => toImapInt(m.imapUid) === uid);
      if (!existing || existing.flagsPending) continue;
      // Le serveur fait foi (lu ou remis non lu ailleurs). Un changement fait dans l'ERP pendant ce
      // relevé (flagsPending) n'est pas écrasé : il sera écrit sur le serveur au passage suivant.
      const mergedRead = readFromServer(existing, isRead);
      if (existing.isRead === mergedRead && existing.isStarred === isStarred) continue;
      const res = await prisma.emailMessage.updateMany({
        where: { id: existing.id, flagsPending: false },
        data: { isRead: mergedRead, isStarred },
      });
      changed += res.count;
    }

    const unreadLocal = await countUnreadInFolder(folder.id);
    await prisma.mailFolder.update({
      where: { id: folder.id },
      data: { unreadCount: unreadLocal },
    });
  });

  return changed;
}

type MessageWithFolder = Prisma.EmailMessageGetPayload<{ include: { folder: true } }>;

export async function resolveMessagesForDelete(id: string): Promise<MessageWithFolder[]> {
  const byPk = await prisma.emailMessage.findUnique({
    where: { id },
    include: { folder: true },
  });
  if (byPk) return [byPk];

  const byRfc = await prisma.emailMessage.findUnique({
    where: { messageId: id },
    include: { folder: true },
  });
  if (byRfc) return [byRfc];

  const inThread = await prisma.emailMessage.findMany({
    where: { threadId: id, orphaned: false },
    include: { folder: true },
  });
  if (inThread.length > 0) return inThread;

  const asUid = Number(id);
  if (Number.isInteger(asUid) && asUid > 0) {
    const byUid = await prisma.emailMessage.findFirst({
      where: { imapUid: asUid, orphaned: false },
      include: { folder: true },
    });
    if (byUid) return [byUid];
  }

  return [];
}

export async function moveMessageToFolder(
  messageId: string,
  targetFolderId: string,
): Promise<void> {
  const message = await prisma.emailMessage.findUnique({
    where: { id: messageId },
    include: { folder: true },
  });
  if (!message) return;
  if (!message.folder || !message.imapUid) {
    throw new Error("Message non synchronisé IMAP");
  }
  const target = await prisma.mailFolder.findUniqueOrThrow({ where: { id: targetFolderId } });

  const oldUid = toImapInt(message.imapUid);
  let newUid: number | undefined;
  await withImapClient(async ({ client }) => {
    await client.mailboxOpen(message.folder!.imapPath);
    // L'uid connu peut dater d'avant un déplacement pas encore relevé : on vérifie que c'est bien ce message,
    // sinon on déplacerait un autre message du dossier (ex. « Annuler » juste après une mise à la corbeille).
    const found = await client.fetchOne(String(oldUid), { envelope: true }, { uid: true });
    const serverMid = found ? found.envelope?.messageId?.trim() : undefined;
    if (!found || (serverMid && serverMid !== message.messageId)) {
      throw new Error("Message pas encore resynchronisé : réessayez dans un instant.");
    }
    const moved = await client.messageMove(String(oldUid), target.imapPath, { uid: true });
    newUid = moved ? moved.uidMap?.get(oldUid) : undefined;
  });

  await prisma.emailMessage.update({
    where: { id: message.id },
    // Nouvel uid connu (UIDPLUS) : un déplacement suivant vise le bon message sans attendre le relevé.
    data: { folderId: target.id, ...(newUid ? { imapUid: newUid } : {}) },
  });
  await refreshFolderUnread([message.folderId, target.id]);
}

/** Mise à la corbeille impossible : le message est CONSERVÉ (jamais de suppression définitive à la place). */
export class TrashUnavailableError extends Error {}

async function deleteResolvedMessage(message: MessageWithFolder, permanent: boolean): Promise<void> {
  // Suppression simple = mise à la corbeille. Si elle échoue (pas de Corbeille, IMAP injoignable),
  // on s'arrête : supprimer définitivement à la place détruirait un message que l'interface dit récupérable.
  // Message présent sur le serveur IMAP : jamais détruit à la place d'une mise à la corbeille.
  // Enregistrement purement local (sans dossier IMAP) : rien à conserver côté boîte, suppression locale.
  const onServer = Boolean(message.folder && message.imapUid);
  if (!permanent && onServer && message.folder?.role !== MailFolderRole.TRASH) {
    const trash = await prisma.mailFolder.findFirst({
      where: { role: MailFolderRole.TRASH, isVirtual: false },
    });
    if (!trash) {
      throw new TrashUnavailableError("Corbeille indisponible : message conservé.");
    }
    try {
      await moveMessageToFolder(message.id, trash.id);
      return;
    } catch {
      throw new TrashUnavailableError("Boîte mail injoignable : message conservé, réessayez plus tard.");
    }
  }

  if (message.folder && message.imapUid) {
    try {
      await withImapClient(async ({ client }) => {
        await client.mailboxOpen(message.folder!.imapPath);
        await client.messageDelete(String(message.imapUid), { uid: true });
      });
    } catch {
      /* déjà absent côté IMAP */
    }
  }

  const threadId = message.threadId;
  await prisma.emailMessage.delete({ where: { id: message.id } }).catch(() => undefined);
  await refreshFolderUnread([message.folderId]);
  await prisma.emailThread
    .update({ where: { id: threadId }, data: { unreadCount: await countUnreadInThread(threadId) } })
    .catch(() => undefined);

  const remaining = await prisma.emailMessage.count({ where: { threadId } });
  if (remaining === 0) {
    await prisma.emailThread.delete({ where: { id: threadId } }).catch(() => undefined);
  }
}

export async function deleteMessage(
  messageId: string,
  permanent = false,
): Promise<{ deleted: number }> {
  const messages = await resolveMessagesForDelete(messageId);
  if (messages.length === 0) return { deleted: 0 };

  let deleted = 0;
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    await deleteResolvedMessage(message, permanent);
    deleted++;
  }
  return { deleted };
}

export async function deleteMessages(
  messageIds: string[],
  permanent = false,
): Promise<{ deleted: number; kept: number; reason: string | null }> {
  let deleted = 0;
  let kept = 0;
  let reason: string | null = null;
  const seen = new Set<string>();
  for (const id of messageIds) {
    const messages = await resolveMessagesForDelete(id);
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      try {
        await deleteResolvedMessage(message, permanent);
        deleted++;
      } catch (err) {
        if (!(err instanceof TrashUnavailableError)) throw err;
        kept++;
        reason = err.message;
      }
    }
  }
  return { deleted, kept, reason };
}

/** Supprime définitivement tous les messages du dossier Corbeille. */
export async function emptyTrashFolder(): Promise<{ deleted: number; kept: number; reason: string | null }> {
  const trash = await prisma.mailFolder.findFirst({
    where: { role: MailFolderRole.TRASH, isVirtual: false },
  });
  if (!trash) return { deleted: 0, kept: 0, reason: null };
  const rows = await prisma.emailMessage.findMany({
    where: { folderId: trash.id },
    select: { id: true },
  });
  if (rows.length === 0) return { deleted: 0, kept: 0, reason: null };
  return deleteMessages(
    rows.map((r) => r.id),
    true,
  );
}

export type MessageListFilter = {
  folderId?: string;
  virtual?: "unread" | "starred" | "attachments";
  audience?: "all" | "clients" | "external";
  clientId?: string;
  search?: string;
  starred?: boolean;
  unread?: boolean;
  hasAttachments?: boolean;
  skip?: number;
  take?: number;
};

export function buildMessageListWhere(filter: MessageListFilter): Prisma.EmailMessageWhereInput {
  const where: Prisma.EmailMessageWhereInput = {
    orphaned: false,
    imapUid: { not: null },
  };

  if (filter.folderId) where.folderId = filter.folderId;
  if (filter.virtual === "unread" || filter.unread) where.isRead = false;
  if (filter.virtual === "starred" || filter.starred) where.isStarred = true;
  if (filter.virtual === "attachments" || filter.hasAttachments) where.hasAttachments = true;
  if (filter.clientId) {
    where.thread = { clientId: filter.clientId };
  } else if (filter.audience === "clients") {
    where.thread = { clientId: { not: null } };
  } else if (filter.audience === "external") {
    where.thread = { clientId: null };
  }

  if (filter.search?.trim()) {
    const q = filter.search.trim();
    where.OR = [
      { subject: { contains: q } },
      { fromAddress: { contains: q } },
      // Corps chiffrés au repos (décision du 27/10/2026) : la recherche porte sur l'aperçu, pas sur tout le corps.
      { snippet: { contains: q } },
    ];
  }

  return where;
}

/** Non lus d'un dossier : même filtre que la liste « Non lus » de la messagerie et la carte du tableau de bord. */
export function countUnreadInFolder(folderId: string): Promise<number> {
  return prisma.emailMessage.count({ where: buildMessageListWhere({ folderId, unread: true }) });
}

export function countUnreadInThread(threadId: string): Promise<number> {
  return prisma.emailMessage.count({ where: { threadId, isRead: false, orphaned: false } });
}

export async function refreshFolderUnread(folderIds: Array<string | null>): Promise<void> {
  for (const id of new Set(folderIds)) {
    if (!id) continue;
    await prisma.mailFolder
      .update({ where: { id }, data: { unreadCount: await countUnreadInFolder(id) } })
      .catch(() => undefined);
  }
}

/**
 * Recalcule en une requête le compteur de non lus de chaque fil dont il a changé : un message lu,
 * supprimé ou déplacé côté serveur le laissait faux (fiche client, liste des fils).
 */
export function recountThreadUnread(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "EmailThread" SET "unreadCount" = (
      SELECT COUNT(*) FROM "EmailMessage" m WHERE m."threadId" = "EmailThread"."id" AND m."isRead" = 0 AND m."orphaned" = 0
    )
    WHERE "unreadCount" <> (
      SELECT COUNT(*) FROM "EmailMessage" m WHERE m."threadId" = "EmailThread"."id" AND m."isRead" = 0 AND m."orphaned" = 0
    )`;
}
