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
  return (
    <ul className="mt-2 space-y-1">
      {attachments.map((a) => (
        <li key={a.id}>
          <a
            href={`/api/emails/attachments/${a.id}`}
            className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg)]"
            download={a.filename}
          >
            <span className="font-medium">{a.filename}</span>
            <span className="text-[var(--muted)]">({formatSize(a.sizeBytes)})</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
