import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faDownload, faPaperclip } from "@fortawesome/free-solid-svg-icons";

type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  const count = attachments.length;
  return (
    <section
      aria-label="Pièces jointes"
      className="mb-4 rounded-[var(--radius)] border border-[var(--primary)]/25 bg-[var(--primary)]/5 p-3"
    >
      <header className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
        <FontAwesomeIcon icon={faPaperclip} className="h-4 w-4 text-[var(--primary)]" aria-hidden />
        {count === 1 ? "1 pièce jointe" : `${count} pièces jointes`}
      </header>
      <ul className="flex flex-wrap gap-2">
        {attachments.map((a) => (
          <li key={a.id}>
            <a
              href={`/api/emails/attachments/${a.id}`}
              className="inline-flex max-w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm shadow-[var(--shadow-sm)] transition hover:border-[var(--primary)]/40 hover:bg-[var(--bg)]"
              download={a.filename}
            >
              <FontAwesomeIcon
                icon={faDownload}
                className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]"
                aria-hidden
              />
              <span className="min-w-0 truncate font-medium">{a.filename}</span>
              <span className="shrink-0 text-xs text-[var(--muted)]">{formatSize(a.sizeBytes)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
