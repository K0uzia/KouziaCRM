import type { MailFolderRole } from "@prisma/client";

export type FolderMapping = Record<MailFolderRole, string | null>;

export const STANDARD_FOLDER_CANDIDATES: Record<
  Exclude<MailFolderRole, "CUSTOM">,
  string[]
> = {
  INBOX: ["INBOX"],
  SENT: ["Sent", "INBOX.Sent", "Sent Messages", "Sent Items"],
  DRAFTS: ["Drafts", "INBOX.Drafts", "Draft"],
  TRASH: ["Trash", "INBOX.Trash", "Deleted", "Deleted Items"],
  JUNK: ["Junk", "Spam", "INBOX.Spam", "Junk E-mail", "Bulk Mail"],
  ARCHIVE: ["Archive", "INBOX.Archive", "Archives"],
};

export function detectFolderRole(
  imapPath: string,
  overrides: Partial<FolderMapping>,
): MailFolderRole {
  const normalized = imapPath.toLowerCase();
  for (const [role, path] of Object.entries(overrides) as Array<
    [MailFolderRole, string | null]
  >) {
    if (path && path.toLowerCase() === normalized) {
      return role;
    }
  }
  for (const [role, candidates] of Object.entries(STANDARD_FOLDER_CANDIDATES) as Array<
    [Exclude<MailFolderRole, "CUSTOM">, string[]]
  >) {
    if (candidates.some((c) => c.toLowerCase() === normalized)) {
      return role;
    }
  }
  if (normalized.includes("sent")) return "SENT";
  if (normalized.includes("draft")) return "DRAFTS";
  if (normalized.includes("trash") || normalized.includes("deleted")) return "TRASH";
  if (normalized.includes("junk") || normalized.includes("spam")) return "JUNK";
  if (normalized.includes("archive")) return "ARCHIVE";
  return "CUSTOM";
}

/** Libellés UI (les chemins IMAP restent inchangés en interne). */
export const FOLDER_ROLE_LABELS: Record<Exclude<MailFolderRole, "CUSTOM">, string> = {
  INBOX: "Boîte de réception",
  SENT: "Envoyés",
  DRAFTS: "Brouillons",
  JUNK: "Indésirables",
  TRASH: "Corbeille",
  ARCHIVE: "Archives",
};

const FOLDER_NAME_LABELS: Record<string, string> = {
  inbox: "Boîte de réception",
  sent: "Envoyés",
  "sent messages": "Envoyés",
  "sent items": "Envoyés",
  drafts: "Brouillons",
  draft: "Brouillons",
  junk: "Indésirables",
  spam: "Indésirables",
  "junk e-mail": "Indésirables",
  "bulk mail": "Indésirables",
  trash: "Corbeille",
  deleted: "Corbeille",
  "deleted items": "Corbeille",
  archive: "Archives",
  archives: "Archives",
};

export function folderDisplayName(imapPath: string, role?: MailFolderRole): string {
  if (role && role !== "CUSTOM") {
    const labeled = FOLDER_ROLE_LABELS[role];
    if (labeled) return labeled;
  }
  const parts = imapPath.split(/[./]/);
  const last = parts[parts.length - 1] || imapPath;
  return FOLDER_NAME_LABELS[last.toLowerCase()] ?? (last || imapPath);
}

export function buildFolderOverrides(settings: {
  imapFolderInbox?: string | null;
  imapFolderSent?: string | null;
  imapFolderDrafts?: string | null;
  imapFolderTrash?: string | null;
  imapFolderJunk?: string | null;
  imapFolderArchive?: string | null;
}): Partial<FolderMapping> {
  return {
    INBOX: settings.imapFolderInbox ?? null,
    SENT: settings.imapFolderSent ?? null,
    DRAFTS: settings.imapFolderDrafts ?? null,
    TRASH: settings.imapFolderTrash ?? null,
    JUNK: settings.imapFolderJunk ?? null,
    ARCHIVE: settings.imapFolderArchive ?? null,
    CUSTOM: null,
  };
}

export const VIRTUAL_FOLDERS = [
  { id: "virtual:unread", role: "CUSTOM" as const, displayName: "Non lus", filter: "unread" as const },
  { id: "virtual:starred", role: "CUSTOM" as const, displayName: "Avec étoile", filter: "starred" as const },
  { id: "virtual:attachments", role: "CUSTOM" as const, displayName: "Avec pièces jointes", filter: "attachments" as const },
] as const;
