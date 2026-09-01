import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faEnvelope,
  faPenToSquare,
  faRotate,
} from "@fortawesome/free-solid-svg-icons";
import type { MailFolderItem } from "@/pages/messaging/MailLayout";
import { Button } from "@/components/ui/Button";

type Props = {
  folders: MailFolderItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSync: () => void;
  onCompose: () => void;
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

function folderLabel(folder: MailFolderItem): string {
  if (folder.role && folder.role !== "CUSTOM" && ROLE_LABELS[folder.role]) {
    return ROLE_LABELS[folder.role];
  }
  const raw = folder.displayName.trim();
  return NAME_LABELS[raw.toLowerCase()] ?? folder.displayName;
}

export function FolderSidebar({ folders, selectedId, onSelect, onSync, onCompose }: Props) {
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
      <nav aria-label="Dossiers" className="flex-1 space-y-0.5 overflow-y-auto">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onSelect(folder.id)}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selectedId === folder.id
                ? "bg-[var(--primary)]/10 font-medium text-[var(--primary)]"
                : "hover:bg-[var(--surface-muted)]"
            }`}
          >
            <span className="flex items-center gap-2 truncate">
              <FontAwesomeIcon icon={faEnvelope} className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
              {folderLabel(folder)}
            </span>
            {(folder.unreadCount ?? 0) > 0 ? (
              <span className="ml-2 rounded-full bg-[var(--primary)] px-2 py-0.5 text-xs text-white">
                {folder.unreadCount}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
