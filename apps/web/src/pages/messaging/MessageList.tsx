import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBars, faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import type { MailMessageItem } from "@/pages/messaging/MailLayout";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { senderLabel } from "@kouziacrm/email-sender";

type Props = {
  messages: MailMessageItem[];
  total: number;
  search: string;
  onSearchChange: (v: string) => void;
  audience: "all" | "clients" | "external";
  audienceCounts: { all: number; clients: number; external: number } | null;
  onAudienceChange: (v: "all" | "clients" | "external") => void;
  selectedId: string | null;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onBulkRead: (read: boolean) => void;
  onBulkDelete: () => void;
  onOpenFolders: () => void;
};

export function MessageList({
  messages,
  total,
  search,
  onSearchChange,
  audience,
  audienceCounts,
  onAudienceChange,
  selectedId,
  selectedIds,
  onSelect,
  onToggleSelect,
  onBulkRead,
  onBulkDelete,
  onOpenFolders,
}: Props) {
  const filters: Array<{ id: "all" | "clients" | "external"; label: string }> = [
    { id: "all", label: "Tous" },
    { id: "clients", label: "Clients" },
    { id: "external", label: "Externes" },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] p-3">
        <div className="mb-2 flex items-center gap-2 md:hidden">
          <Button variant="secondary" className="h-9 px-3" onClick={onOpenFolders}>
            <FontAwesomeIcon icon={faBars} className="h-4 w-4" />
            Dossiers
          </Button>
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {filters.map((f) => {
            const count =
              f.id === "all"
                ? audienceCounts?.all
                : f.id === "clients"
                  ? audienceCounts?.clients
                  : audienceCounts?.external;
            return (
              <button
                key={f.id}
                type="button"
                className={`rounded-full px-3 py-1 text-xs ${
                  audience === f.id
                    ? "bg-[var(--primary)] text-white"
                    : "bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--text)]"
                }`}
                onClick={() => onAudienceChange(f.id)}
              >
                {f.label}
                {count != null ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
        <div className="relative">
          <FontAwesomeIcon
            icon={faMagnifyingGlass}
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-40"
          />
          <Input
            className="pl-9"
            placeholder="Rechercher…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {selectedIds.size > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => onBulkRead(true)}>
              Lu
            </Button>
            <Button variant="secondary" onClick={() => onBulkRead(false)}>
              Non lu
            </Button>
            <Button variant="danger" onClick={onBulkDelete}>
              Supprimer
            </Button>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-[var(--muted)]">{total} message(s)</p>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {messages.map((msg) => (
          <li key={msg.id}>
            <div
              className={`flex gap-2 border-b border-[var(--border)] px-3 py-3 ${
                selectedId === msg.id ? "bg-[var(--primary)]/5" : "hover:bg-[var(--surface-muted)]"
              } ${!msg.isRead ? "font-semibold" : ""}`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selectedIds.has(msg.id)}
                onChange={() => onToggleSelect(msg.id)}
                aria-label={`Sélectionner ${msg.subject}`}
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelect(msg.id)}
              >
                <div className="flex justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    {!msg.isRead ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-[var(--primary)]"
                        aria-label="Non lu"
                      />
                    ) : null}
                    <span className="truncate text-sm">
                      {senderLabel(msg.fromName, msg.fromAddress)}
                    </span>
                  </span>
                  <time className="shrink-0 text-xs font-normal text-[var(--muted)]">
                    {formatDate(msg.receivedAt)}
                  </time>
                </div>
                <p className="truncate text-sm">{msg.subject}</p>
                {msg.thread?.client ? (
                  <span className="mt-1 inline-block rounded bg-teal-100 px-1.5 py-0.5 text-xs font-normal text-teal-800">
                    {msg.thread.client.displayName}
                  </span>
                ) : null}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
