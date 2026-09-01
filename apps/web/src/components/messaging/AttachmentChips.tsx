import { useRef, type ChangeEvent, type DragEvent } from "react";
import { faPaperclip, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button } from "@/components/ui/Button";

export type AttachmentChipItem = {
  id: string;
  filename: string;
  sizeBytes: number;
  kind: "file" | "document";
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

type Props = {
  items: AttachmentChipItem[];
  onRemove: (id: string) => void;
  onAddFiles: (files: FileList | File[]) => void;
  disabled?: boolean;
};

export function AttachmentChips({ items, onRemove, onAddFiles, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) onAddFiles(e.target.files);
    e.target.value = "";
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    if (disabled) return;
    if (e.dataTransfer.files?.length) onAddFiles(e.dataTransfer.files);
  }

  return (
    <div className="space-y-2">
      <div
        className="rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-[var(--bg)] p-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {items.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">
            Glissez des fichiers ici ou utilisez le bouton ci-dessous.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs"
              >
                <span className="truncate" title={item.filename}>
                  {item.kind === "document" ? "PDF · " : ""}
                  {item.filename}
                </span>
                <span className="text-[var(--muted)]">{formatSize(item.sizeBytes)}</span>
                <button
                  type="button"
                  className="text-[var(--muted)] hover:text-[var(--text)]"
                  disabled={disabled}
                  aria-label={`Retirer ${item.filename}`}
                  onClick={() => onRemove(item.id)}
                >
                  <FontAwesomeIcon icon={faXmark} className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPick}
      />
      <Button
        type="button"
        variant="secondary"
        className="h-8 text-xs"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <FontAwesomeIcon icon={faPaperclip} className="mr-2 h-3 w-3" />
        Joindre un fichier
      </Button>
    </div>
  );
}
