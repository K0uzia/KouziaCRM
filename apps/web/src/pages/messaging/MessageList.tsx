import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBars,
  faEnvelope,
  faEnvelopeOpen,
  faMagnifyingGlass,
  faPaperclip,
  faReply,
  faStar,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import type { MailMessageItem } from "@/pages/messaging/MailLayout";
import { formatShortDate } from "@/lib/format";
import { FilterSegment, FilterSelect } from "@/components/ui/ListFilters";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { senderLabel } from "@kouzia-erp/email-sender";
import { formProspectName } from "@/pages/messaging/sender";

type Props = {
  messages: MailMessageItem[];
  total: number;
  /** Messages suivants (chargement progressif) ; loadingMore : chargement en cours. */
  onLoadMore: () => void;
  loadingMore: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  audience: "all" | "clients" | "external";
  audienceCounts: { all: number; clients: number; external: number } | null;
  onAudienceChange: (v: "all" | "clients" | "external") => void;
  viewFilter: "all" | "unread" | "starred" | "attachments";
  onViewFilterChange: (v: "all" | "unread" | "starred" | "attachments") => void;
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

/**
 * Nom affiché sur la ligne, comme Gmail : l'expéditeur réel (le client rattaché va dans le badge).
 * Formulaire du site relayé (Web3Forms) : le prospect est dans Reply-To, pas dans From.
 */
function personLabel(msg: MailMessageItem): string {
  const c = msg.thread?.client;
  const clientName = c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.displayName?.trim() || "" : "";
  // Sans nom d'affichage, le client rattaché est plus parlant qu'une adresse brute.
  const named = (name: string | null | undefined, address: string) =>
    name?.trim() && name.trim().toLowerCase() !== address.toLowerCase()
      ? senderLabel(name, address)
      : clientName || senderLabel(null, address);
  if (msg.direction === "OUTBOUND") {
    const to = msg.toAddresses?.[0] ?? "";
    return to ? named(null, to) : "Destinataire inconnu";
  }
  if (msg.replyToAddress) return formProspectName(msg.snippet) ?? named(null, msg.replyToAddress);
  return named(msg.fromName, msg.fromAddress);
}

function companyTag(msg: MailMessageItem): string | null {
  const c = msg.thread?.client;
  if (!c) return null;
  const company = c.companyName?.trim();
  if (company) return company;
  // Structure sans companyName : displayName si différent du nom personne
  if ((c.type === "B2B" || c.type === "ASSOCIATION") && c.displayName) {
    const person = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    if (person && c.displayName !== person) return c.displayName;
  }
  return null;
}

/** Appui long (téléphone) : sélection du message, comme Gmail. */
const LONG_PRESS_MS = 450;

/**
 * Après un appui long, le relâchement du doigt produit un clic : il est neutralisé partout dans la
 * page (capture), pour qu'il ne déclenche jamais un bouton apparu entre-temps sous le doigt.
 */
function swallowNextClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => document.removeEventListener("click", stop, { capture: true }), 800);
}

function ClientTag({ label }: { label: string }) {
  return (
    <span className="inline-block max-w-[50%] shrink-0 truncate rounded-[var(--radius-sm)] bg-[var(--info-soft)] px-1.5 text-xs leading-5 text-[var(--info)]">
      {label}
    </span>
  );
}

export function MessageList({
  messages,
  total,
  onLoadMore,
  loadingMore,
  search,
  onSearchChange,
  audience,
  audienceCounts,
  onAudienceChange,
  viewFilter,
  onViewFilterChange,
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
  const viewFilters: Array<{
    id: "all" | "unread" | "starred" | "attachments";
    label: string;
  }> = [
    { id: "all", label: "Tous les messages" },
    { id: "unread", label: "Non lus" },
    { id: "starred", label: "Favoris" },
    { id: "attachments", label: "Avec pièces jointes" },
  ];
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const pointerType = useRef("mouse");
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
        className={`flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] transition ${
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

  const selecting = selectedIds.size > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-[var(--border)] p-3">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="shrink-0 px-3 md:hidden"
            onClick={onOpenFolders}
            aria-label="Dossiers"
          >
            <FontAwesomeIcon icon={faBars} className="h-4 w-4" aria-hidden />
          </Button>
          <div className="relative min-w-0 flex-1">
            <FontAwesomeIcon
              icon={faMagnifyingGlass}
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-40"
              aria-hidden
            />
            <Input
              className="pl-9"
              type="search"
              aria-label="Rechercher dans les messages"
              placeholder="Rechercher…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        </div>
        {/* Deux dimensions : expéditeurs (contrôle segmenté, avec le nombre) et affichage (liste native). */}
        <div className="flex min-w-0 flex-wrap items-end gap-2 sm:gap-3">
          <FilterSegment
            label="Expéditeurs"
            compact
            value={audience}
            onChange={onAudienceChange}
            options={filters.map((f) => ({
              id: f.id,
              label: f.label,
              count: f.id === "all" ? audienceCounts?.all : f.id === "clients" ? audienceCounts?.clients : audienceCounts?.external,
            }))}
          />
          <FilterSelect label="Afficher" compact value={viewFilter} onChange={onViewFilterChange} options={viewFilters} className="sm:w-48" />
        </div>
        {selecting ? (
          // Téléphone : barre en surimpression au-dessus des onglets du bas, hors du flux, pour que la
          // liste ne bouge pas sous le doigt (sinon le relâchement d'un appui long tombe sur un bouton).
          <div
            className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] p-2 shadow-[var(--shadow)] lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none"
            role="toolbar"
            aria-label="Messages sélectionnés"
          >
            <span className="text-sm font-medium">{selectedIds.size} sélectionné(s)</span>
            <Button variant="secondary" className="text-xs" onClick={() => onBulkRead(true)}>
              Lu
            </Button>
            <Button variant="secondary" className="text-xs" onClick={() => onBulkRead(false)}>
              Non lu
            </Button>
            {onBulkStar ? (
              <Button variant="secondary" className="text-xs" onClick={() => onBulkStar(true)}>
                Favoris
              </Button>
            ) : null}
            <Button variant="danger" className="text-xs" onClick={onBulkDelete}>
              {isTrashFolder ? "Supprimer définitivement" : "Supprimer"}
            </Button>
            <Button variant="ghost" className="text-xs" onClick={onClearSelection}>
              Annuler
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label
            className={`inline-flex min-h-11 items-center gap-2 text-xs text-[var(--muted)] ${selecting ? "" : "invisible md:visible"}`}
          >
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
            />
            Tout sélectionner
          </label>
          <p className="text-xs text-[var(--muted)]">
            {messages.length < total ? `${messages.length} sur ${total} messages` : `${total} message(s)`}
          </p>
          {isTrashFolder && onEmptyTrash ? (
            <Button variant="danger" className="ml-auto text-xs" onClick={onEmptyTrash}>
              Vider la corbeille
            </Button>
          ) : null}
        </div>
      </div>
      <ul className={`custom-scrollbar flex-1 overflow-y-auto ${selecting ? "pb-28 lg:pb-0" : ""}`}>
        {messages.map((msg) => {
          const name = personLabel(msg);
          const clientTag = companyTag(msg) ?? msg.thread?.client?.displayName ?? null;
          // Badge client seulement s'il apporte une information (pas le même nom que l'expéditeur).
          const tag = clientTag && clientTag.toLowerCase() !== name.toLowerCase() ? clientTag : null;
          const unread = !msg.isRead;
          const checked = selectedIds.has(msg.id);
          return (
            <li key={msg.id}>
              <div
                className={`group relative flex items-stretch border-b border-[var(--border)] ${
                  checked
                    ? "bg-[var(--primary-soft)]"
                    : selectedId === msg.id
                      ? "bg-[var(--surface-raised)]"
                      : "hover:bg-[var(--surface-raised)]"
                }`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Téléphone : l'appui long sélectionne (comme Gmail) ; souris : menu contextuel.
                  if (pointerType.current === "mouse") setCtx({ msg, x: e.clientX, y: e.clientY });
                }}
              >
                <label
                  className={`min-w-11 shrink-0 cursor-pointer items-center justify-center ${selecting ? "flex" : "hidden md:flex"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleSelect(msg.id)}
                    aria-label={`Sélectionner : ${msg.subject || "(sans objet)"}`}
                  />
                </label>
                <button
                  type="button"
                  className={`min-w-0 flex-1 py-2.5 pr-3 text-left ${selecting ? "" : "pl-3 md:pl-0"}`}
                  onPointerDown={(e) => {
                    pointerType.current = e.pointerType;
                    if (e.pointerType !== "touch") return;
                    clearTimeout(pressTimer.current);
                    pressTimer.current = setTimeout(() => {
                      onToggleSelect(msg.id);
                      swallowNextClick();
                    }, LONG_PRESS_MS);
                  }}
                  onPointerUp={() => clearTimeout(pressTimer.current)}
                  onPointerLeave={() => clearTimeout(pressTimer.current)}
                  onPointerCancel={() => clearTimeout(pressTimer.current)}
                  onClick={() => {
                    // En mode sélection, un appui ajoute ou retire le message au lieu de l'ouvrir.
                    if (selecting) onToggleSelect(msg.id);
                    else onSelect(msg.id);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${unread ? "bg-[var(--primary)]" : "bg-transparent"}`}
                      aria-hidden
                    />
                    <span className={`min-w-0 flex-1 truncate text-sm text-[var(--text)] ${unread ? "font-semibold" : ""}`}>
                      {msg.direction === "OUTBOUND" ? <span className="font-normal text-[var(--muted)]">À : </span> : null}
                      {name}
                    </span>
                    <time
                      dateTime={msg.receivedAt}
                      className={`shrink-0 whitespace-nowrap text-xs tabular-nums ${unread ? "font-semibold text-[var(--primary)]" : "text-[var(--muted)]"}`}
                    >
                      {formatShortDate(msg.receivedAt)}
                    </time>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 pl-4">
                    <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold" : ""}`}>
                      {msg.subject || "(sans objet)"}
                    </span>
                    {msg.hasAttachments ? (
                      <>
                        {/* Icône masquée aux lecteurs d'écran (Font Awesome) : l'information est dite en texte. */}
                        <FontAwesomeIcon icon={faPaperclip} className="h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
                        <span className="sr-only">Pièce jointe</span>
                      </>
                    ) : null}
                    {msg.isStarred ? (
                      <>
                        <FontAwesomeIcon icon={faStar} className="h-3 w-3 shrink-0 text-[var(--warning)]" aria-hidden />
                        <span className="sr-only">Favori</span>
                      </>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 pl-4">
                    {tag ? <ClientTag label={tag} /> : null}
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">{msg.snippet}</span>
                  </span>
                  {unread ? <span className="sr-only">, non lu</span> : null}
                </button>
                <div className="hidden shrink-0 items-center gap-0.5 pr-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 lg:flex">
                  {actionBtn(
                    msg.isStarred ? "Retirer des favoris" : "Ajouter aux favoris",
                    faStar,
                    () => onToggleStar(msg),
                    msg.isStarred ? "active" : "default",
                  )}
                  {msg.direction !== "OUTBOUND" ? actionBtn("Répondre", faReply, () => onReply(msg)) : null}
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
        {messages.length < total ? (
          <li className="p-3">
            <Button variant="secondary" className="w-full" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? "Chargement…" : `Afficher les messages suivants (${Math.min(50, total - messages.length)} sur ${total - messages.length} restants)`}
            </Button>
          </li>
        ) : null}
      </ul>

      {ctx ? (
        <div
          ref={ctxRef}
          role="menu"
          className="fixed z-50 min-w-[11.25rem] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] py-1 shadow-[var(--shadow-sm)]"
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
