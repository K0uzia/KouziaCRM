import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBan,
  faBoxArchive,
  faFileLines,
  faFolder,
  faInbox,
  faPaperPlane,
  faPenToSquare,
  faRotate,
  faTrashCan,
  type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import type { MailFolderItem } from "@/pages/messaging/MailLayout";
import { Button } from "@/components/ui/Button";

type Props = {
  folders: MailFolderItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSync: () => void;
  onCompose: () => void;
  /** « il y a 3 min » : dernière synchro réussie (null si jamais). */
  lastSync?: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  INBOX: "Boîte de réception",
  SENT: "Envoyés",
  DRAFTS: "Brouillons",
  JUNK: "Indésirables",
  TRASH: "Corbeille",
  ARCHIVE: "Archives",
};

const NAME_LABELS: Record<string, string> = {
  inbox: "Boîte de réception",
  sent: "Envoyés",
  drafts: "Brouillons",
  draft: "Brouillons",
  junk: "Indésirables",
  spam: "Indésirables",
  trash: "Corbeille",
  deleted: "Corbeille",
  archive: "Archives",
  archives: "Archives",
};

const NAME_ROLES: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFTS",
  draft: "DRAFTS",
  junk: "JUNK",
  spam: "JUNK",
  trash: "TRASH",
  deleted: "TRASH",
  archive: "ARCHIVE",
  archives: "ARCHIVE",
};

/** Icônes conventionnelles des clients de messagerie (Gmail, Outlook, Apple Mail). */
const ROLE_ICONS: Record<string, IconDefinition> = {
  INBOX: faInbox,
  SENT: faPaperPlane,
  DRAFTS: faFileLines,
  JUNK: faBan,
  TRASH: faTrashCan,
  ARCHIVE: faBoxArchive,
};

function folderIcon(folder: MailFolderItem): IconDefinition {
  const role = folder.role && folder.role !== "CUSTOM" ? folder.role : NAME_ROLES[folder.displayName.trim().toLowerCase()];
  return (role && ROLE_ICONS[role]) || faFolder;
}

function folderLabel(folder: MailFolderItem): string {
  if (folder.role && folder.role !== "CUSTOM" && ROLE_LABELS[folder.role]) {
    return ROLE_LABELS[folder.role];
  }
  const raw = folder.displayName.trim();
  return NAME_LABELS[raw.toLowerCase()] ?? folder.displayName;
}

export function FolderSidebar({ folders, selectedId, onSelect, onSync, onCompose, lastSync }: Props) {
  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-3 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onSync} aria-label="Synchroniser">
          <FontAwesomeIcon icon={faRotate} className="h-4 w-4" aria-hidden />
        </Button>
        <Button className="flex-1" onClick={onCompose}>
          <FontAwesomeIcon icon={faPenToSquare} className="h-4 w-4" aria-hidden />
          Écrire
        </Button>
      </div>
      {lastSync ? (
        <p className="mb-2 px-1 text-xs text-[var(--muted)]">Dernière synchro {lastSync}</p>
      ) : null}
      <nav aria-label="Dossiers" className="custom-scrollbar flex-1 space-y-0.5 overflow-y-auto">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onSelect(folder.id)}
            className={`flex min-h-11 w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selectedId === folder.id
                ? "bg-[var(--primary)]/10 font-medium text-[var(--primary)]"
                : "hover:bg-[var(--surface-hover)]"
            }`}
          >
            <span className="flex items-center gap-2 truncate">
              <FontAwesomeIcon icon={folderIcon(folder)} className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
              {folderLabel(folder)}
            </span>
            {(folder.unreadCount ?? 0) > 0 ? (
              <span className="ml-2 rounded-full bg-[var(--primary)] px-2 py-0.5 text-xs font-semibold text-[var(--primary-fg)]">
                {folder.unreadCount}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
