import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBars,
  faEnvelope,
  faEnvelopeOpen,
  faMagnifyingGlass,
  faReply,
  faStar,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import type { MailMessageItem } from "@/pages/messaging/MailLayout";
import { formatDate, formatTime } from "@/lib/format";
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
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onBulkRead: (read: boolean) => void;
  onBulkDelete: () => void;
  onBulkStar?: (starred: boolean) => void;
  onOpenFolders: () => void;
  onReply: (msg: MailMessageItem) => void;
  onDelete: (msg: MailMessageItem) => void;
  onToggleRead: (msg: MailMessageItem) => void;
  onToggleStar: (msg: MailMessageItem) => void;
  isTrashFolder?: boolean;
  onEmptyTrash?: () => void;
};

type CtxMenu = {
  msg: MailMessageItem;
  x: number;
  y: number;
};

function personLabel(msg: MailMessageItem): string {
  const c = msg.thread?.client;
  if (c) {
    const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    if (full) return full;
    if (c.displayName?.trim()) return c.displayName.trim();
  }
  if (msg.direction === "OUTBOUND") {
    const to = msg.toAddresses?.[0] ?? "";
    return to ? senderLabel(null, to) : "Destinataire inconnu";
  }
  return senderLabel(msg.fromName, msg.fromAddress);
}

function companyTag(msg: MailMessageItem): string | null {
  const c = msg.thread?.client;
  if (!c) return null;
  const company = c.companyName?.trim();
  if (company) return company;
  // B2B sans companyName : displayName si différent du nom personne
  if (c.type === "B2B" && c.displayName) {
    const person = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    if (person && c.displayName !== person) return c.displayName;
  }
  return null;
}

function contactEmail(msg: MailMessageItem): string | null {
  if (msg.direction === "OUTBOUND") {
    return msg.toAddresses?.[0] ?? null;
  }
  return msg.fromAddress || null;
}

function ClientTag({ label }: { label: string }) {
  return (
    <span className="inline-block shrink-0 rounded bg-teal-100 px-1.5 py-0.5 text-xs font-normal text-teal-800 dark:bg-teal-950/50 dark:text-teal-200">
      {label}
    </span>
  );
}

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
  onSelectAll,
  onClearSelection,
  onBulkRead,
  onBulkDelete,
  onBulkStar,
  onOpenFolders,
  onReply,
  onDelete,
  onToggleRead,
  onToggleStar,
  isTrashFolder,
  onEmptyTrash,
}: Props) {
  const filters: Array<{ id: "all" | "clients" | "external"; label: string }> = [
    { id: "all", label: "Tous" },
    { id: "clients", label: "Clients" },
    { id: "external", label: "Externes" },
  ];
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);
  const allIds = messages.map((m) => m.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0 && !allSelected;

  useEffect(() => {
    if (!ctx) return;
    function close() {
      setCtx(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onPointer(e: MouseEvent) {
      if (ctxRef.current?.contains(e.target as Node)) return;
      close();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctx]);

  function actionBtn(
    label: string,
    icon: typeof faReply,
    onClick: () => void,
    tone: "default" | "danger" | "active" = "default",
  ) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        className={`flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition ${
          tone === "danger"
            ? "text-[var(--danger)] hover:bg-[var(--danger-soft)]"
            : tone === "active"
              ? "text-[var(--warning)] hover:bg-[var(--warning-soft)]"
              : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <FontAwesomeIcon icon={icon} className="h-3.5 w-3.5" />
      </button>
    );
  }

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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected;
              }}
              onChange={() => {
                if (allSelected) onClearSelection();
                else onSelectAll(allIds);
              }}
              aria-label="Tout sélectionner"
            />
            Tout sélectionner
          </label>
          {isTrashFolder && onEmptyTrash ? (
            <Button variant="danger" className="h-8 px-3 text-xs" onClick={onEmptyTrash}>
              Vider la corbeille
            </Button>
          ) : null}
        </div>
        {selectedIds.size > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" className="h-8 text-xs" onClick={() => onBulkRead(true)}>
              Lu
            </Button>
            <Button variant="secondary" className="h-8 text-xs" onClick={() => onBulkRead(false)}>
              Non lu
            </Button>
            {onBulkStar ? (
              <Button
                variant="secondary"
                className="h-8 text-xs"
                onClick={() => onBulkStar(true)}
              >
                Favoris
              </Button>
            ) : null}
            <Button variant="danger" className="h-8 text-xs" onClick={onBulkDelete}>
              {isTrashFolder ? "Supprimer définitivement" : "Supprimer"}
            </Button>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-[var(--muted)]">{total} message(s)</p>
      </div>
      <ul className="custom-scrollbar flex-1 overflow-y-auto">
        {messages.map((msg) => {
          const name = personLabel(msg);
          const email = contactEmail(msg);
          const tag = companyTag(msg);
          const emailDiffers =
            Boolean(email) && name.toLowerCase() !== email!.toLowerCase();
          return (
            <li key={msg.id}>
              <div
                className={`group flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5 ${
                  selectedId === msg.id
                    ? "bg-[var(--primary)]/5"
                    : "hover:bg-[var(--surface-muted)]"
                } ${!msg.isRead ? "font-semibold" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({ msg, x: e.clientX, y: e.clientY });
                }}
              >
                <input
                  type="checkbox"
                  className="shrink-0"
                  checked={selectedIds.has(msg.id)}
                  onChange={() => onToggleSelect(msg.id)}
                  aria-label={`Sélectionner ${msg.subject}`}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onSelect(msg.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {!msg.isRead ? (
                          <span
                            className="size-1.5 shrink-0 rounded-full bg-[var(--primary)]"
                            aria-label="Non lu"
                          />
                        ) : null}
                        {msg.isStarred ? (
                          <FontAwesomeIcon
                            icon={faStar}
                            className="h-3 w-3 shrink-0 text-[var(--warning)]"
                            aria-label="Favori"
                          />
                        ) : null}
                        {msg.direction === "OUTBOUND" ? (
                          <span className="min-w-0 truncate text-sm">
                            <span className="font-normal text-[var(--muted)]">À : </span>
                            {name}
                            {emailDiffers ? (
                              <span className="font-normal text-[var(--muted)]">
                                {" "}
                                &lt;{email}&gt;
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="truncate text-sm">{name}</span>
                        )}
                        {tag ? (
                          <>
                            <span className="shrink-0 text-xs font-normal text-[var(--muted)]">
                              -
                            </span>
                            <ClientTag label={tag} />
                          </>
                        ) : null}
                      </div>
                      {msg.direction !== "OUTBOUND" && emailDiffers ? (
                        <p className="truncate text-xs font-normal text-[var(--muted)]">
                          &lt;{email}&gt;
                        </p>
                      ) : null}
                      <p className="truncate text-sm">
                        <span className="font-normal text-[var(--muted)]">Sujet : </span>
                        {msg.subject || "(sans objet)"}
                      </p>
                    </div>
                    <time className="shrink-0 text-right text-xs font-normal text-[var(--muted)]">
                      <span className="block">{formatDate(msg.receivedAt)}</span>
                      <span className="block tabular-nums">{formatTime(msg.receivedAt)}</span>
                    </time>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  {actionBtn(
                    msg.isStarred ? "Retirer des favoris" : "Ajouter aux favoris",
                    faStar,
                    () => onToggleStar(msg),
                    msg.isStarred ? "active" : "default",
                  )}
                  {msg.direction !== "OUTBOUND"
                    ? actionBtn("Répondre", faReply, () => onReply(msg))
                    : null}
                  {actionBtn(
                    msg.isRead ? "Marquer non lu" : "Marquer lu",
                    msg.isRead ? faEnvelope : faEnvelopeOpen,
                    () => onToggleRead(msg),
                  )}
                  {actionBtn("Supprimer", faTrash, () => onDelete(msg), "danger")}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {ctx ? (
        <div
          ref={ctxRef}
          role="menu"
          className="fixed z-50 min-w-[180px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] py-1 shadow-[var(--shadow-sm)]"
          style={{
            left: Math.min(ctx.x, window.innerWidth - 200),
            top: Math.min(ctx.y, window.innerHeight - 180),
          }}
        >
          {(
            [
              {
                label: "Ouvrir",
                run: () => onSelect(ctx.msg.id),
              },
              ...(ctx.msg.direction !== "OUTBOUND"
                ? [{ label: "Répondre", run: () => onReply(ctx.msg) }]
                : []),
              {
                label: ctx.msg.isStarred ? "Retirer des favoris" : "Ajouter aux favoris",
                run: () => onToggleStar(ctx.msg),
              },
              {
                label: ctx.msg.isRead ? "Marquer non lu" : "Marquer lu",
                run: () => onToggleRead(ctx.msg),
              },
              {
                label: isTrashFolder ? "Supprimer définitivement" : "Supprimer",
                run: () => onDelete(ctx.msg),
                danger: true,
              },
            ] as const
          ).map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-hover)] ${
                "danger" in item && item.danger
                  ? "text-[var(--danger)]"
                  : "text-[var(--text)]"
              }`}
              onClick={() => {
                setCtx(null);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
