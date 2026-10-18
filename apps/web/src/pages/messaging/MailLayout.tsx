import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useUrlFilters, withParam } from "@/lib/use-url-filters";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope } from "@fortawesome/free-solid-svg-icons";
import { ButtonLink } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { notifyMailChanged } from "@/lib/mailEvents";
import { FolderSidebar } from "@/pages/messaging/FolderSidebar";
import { MessageList } from "@/pages/messaging/MessageList";
import { ReadingPane } from "@/pages/messaging/ReadingPane";
import { ComposeModal } from "@/pages/messaging/ComposeModal";
import { useInboxSync } from "@/pages/messaging/useInboxSync";
import { useMailNotifications } from "@/pages/messaging/useMailNotifications";
import { isFormSender } from "@/pages/messaging/sender";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatAgoMinutes, formatDate, formatTime, MAIL_SYNC_STALE_MIN, minutesSince } from "@/lib/format";

export type MailFolderItem = {
  id: string;
  imapPath?: string;
  displayName: string;
  role: string;
  unreadCount?: number;
  isVirtual?: boolean;
};

export type MailMessageItem = {
  id: string;
  messageId?: string;
  threadId: string;
  subject: string;
  snippet: string;
  fromAddress: string;
  replyToAddress?: string | null;
  fromName?: string | null;
  toAddresses?: string[];
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  direction: string;
  thread?: {
    id: string;
    subject: string;
    unreadCount?: number;
    client?: {
      id: string;
      displayName: string;
      firstName?: string | null;
      lastName?: string | null;
      companyName?: string | null;
      type?: string | null;
    } | null;
  };
};

export type SyncStatus = {
  connected: boolean;
  idleActive: boolean;
  lastError?: string | null;
  lastSyncAt?: string | null;
};

const MESSAGES_PAGE = 50;
type Audience = "all" | "clients" | "external";
type ViewFilter = "all" | "unread" | "starred" | "attachments";
const AUDIENCE = { tous: "all", clients: "clients", externes: "external" } as const satisfies Record<string, Audience>;
const AUDIENCE_SLUG: Record<Audience, string> = { all: "tous", clients: "clients", external: "externes" };
const VIEW = { tout: "all", "non-lus": "unread", favoris: "starred", "pieces-jointes": "attachments" } as const satisfies Record<string, ViewFilter>;
const VIEW_SLUG: Record<ViewFilter, string> = { all: "tout", unread: "non-lus", starred: "favoris", attachments: "pieces-jointes" };

export function MailLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { threadId } = useParams<{ threadId?: string }>();
  const isReading = Boolean(threadId);

  const [folders, setFolders] = useState<MailFolderItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MailMessageItem[]>([]);
  const [total, setTotal] = useState(0);
  // Filtres dans l'URL (?q=, ?expediteurs=, ?afficher=) : gardés à l'ouverture d'un fil et au retour.
  const filters = useUrlFilters();
  const search = filters.text("q");
  const audience = AUDIENCE[filters.pick("expediteurs", ["tous", "clients", "externes"] as const, "tous")];
  const viewFilter = VIEW[filters.pick("afficher", ["tout", "non-lus", "favoris", "pieces-jointes"] as const, "tout")];
  const setSearch = (q: string) => filters.set({ q });
  const setAudience = (a: Audience) => filters.set({ expediteurs: a === "all" ? null : AUDIENCE_SLUG[a] });
  const setViewFilter = (v: ViewFilter) => filters.set({ afficher: v === "all" ? null : VIEW_SLUG[v] });
  const setViewFilterRef = useRef(setViewFilter);
  setViewFilterRef.current = setViewFilter;
  const [audienceCounts, setAudienceCounts] = useState<{ all: number; clients: number; external: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDefaults, setComposeDefaults] = useState<{
    to?: string;
    clientId?: string;
    threadId?: string;
    inReplyTo?: string;
    subject?: string;
    body?: string;
  }>({});
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [emptyTrashBusy, setEmptyTrashBusy] = useState(false);
  const selectedFolderIdRef = useRef(selectedFolderId);
  selectedFolderIdRef.current = selectedFolderId;
  const messagesLoadGen = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFolders = useCallback(async () => {
    const data = await api<{
      folders: MailFolderItem[];
      syncStatus: SyncStatus;
    }>("/api/emails/folders");
    setFolders(data.folders);
    setSyncStatus(data.syncStatus);
    const current = selectedFolderIdRef.current;
    if (!current || current.startsWith("virtual:")) {
      const inbox = data.folders.find((f) => f.role === "INBOX");
      if (inbox) setSelectedFolderId(inbox.id);
      else if (data.folders[0]) setSelectedFolderId(data.folders[0].id);
      if (current?.startsWith("virtual:")) {
        const v = current.replace("virtual:", "");
        if (v === "unread" || v === "starred" || v === "attachments") {
          setViewFilterRef.current(v);
        }
      }
    }
  }, []);

  // Chargement progressif : 50 messages, puis 50 de plus à la demande. Une actualisation (synchro, action)
  // recharge autant de messages qu'affichés, pas seulement les 50 premiers ; un autre filtre repart de 50.
  const wantedRef = useRef(MESSAGES_PAGE);
  const listKeyRef = useRef("");
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMessages = useCallback(async () => {
    const folderId = selectedFolderIdRef.current;
    if (!folderId || folderId.startsWith("virtual:")) return;
    const gen = ++messagesLoadGen.current;
    const params = new URLSearchParams();
    params.set("folderId", folderId);
    if (search.trim()) params.set("q", search.trim());
    if (audience !== "all") params.set("audience", audience);
    if (viewFilter === "unread") params.set("unread", "true");
    if (viewFilter === "starred") params.set("starred", "true");
    if (viewFilter === "attachments") params.set("hasAttachments", "true");
    const key = params.toString();
    if (key !== listKeyRef.current) {
      listKeyRef.current = key;
      wantedRef.current = MESSAGES_PAGE;
    }
    type Page = { messages: MailMessageItem[]; total: number; audienceCounts: { all: number; clients: number; external: number } };
    const loaded: MailMessageItem[] = [];
    let page: Page;
    // Pages de 100 au plus (limite de l'API) jusqu'au nombre voulu ou à la fin du dossier.
    do {
      params.set("skip", String(loaded.length));
      params.set("take", String(Math.min(100, wantedRef.current - loaded.length)));
      page = await api<Page>(`/api/emails/messages?${params}`);
      if (gen !== messagesLoadGen.current) return;
      loaded.push(...page.messages);
    } while (page.messages.length > 0 && loaded.length < Math.min(wantedRef.current, page.total));
    setMessages(loaded);
    setTotal(page.total);
    setAudienceCounts(page.audienceCounts);
  }, [selectedFolderId, search, audience, viewFilter]);

  async function loadMore() {
    wantedRef.current += MESSAGES_PAGE;
    setLoadingMore(true);
    try {
      await loadMessages();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Messages suivants non chargés.");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Même erreur venant des dossiers et des messages : un seul toast (id stable). */
  const [notConfigured, setNotConfigured] = useState(false);
  const notifyLoadError = useCallback((e: Error) => {
    // Boîte non connectée : état dédié à l'écran plutôt qu'un toast d'erreur.
    if (/IMAP non configur/i.test(e.message)) {
      setNotConfigured(true);
      return;
    }
    toast.error(e.message, { id: "mail-load-error" });
  }, []);

  const refresh = useCallback(async () => {
    notifyMailChanged();
    await loadFolders();
    await loadMessages();
  }, [loadFolders, loadMessages]);

  /** Évite les rafales focus + lastSyncAt + sync manuelle qui font clignoter la liste. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void refresh().catch(notifyLoadError);
    }, 400);
  }, [refresh]);

  useEffect(() => {
    void loadFolders().catch(notifyLoadError);
  }, [loadFolders]);

  useEffect(() => {
    void loadMessages().catch(notifyLoadError);
  }, [loadMessages]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useInboxSync(scheduleRefresh);
  useMailNotifications(scheduleRefresh, syncStatus, setSyncStatus);

  // « Dernière synchro il y a X min » se met à jour sans recharger la page.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const syncAge = minutesSince(syncStatus?.lastSyncAt, clock);

  async function syncNow() {
    try {
      await api("/api/emails/sync", { method: "POST" });
      toast.success("Synchronisation terminée");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur sync");
    }
  }

  function openCompose(opts: typeof composeDefaults = {}) {
    setComposeDefaults(opts);
    setComposeOpen(true);
  }

  function openMessage(msg: MailMessageItem) {
    setSelectedMessageId(msg.id);
    setMessages((prev) =>
      prev.map((m) => (m.threadId === msg.threadId ? { ...m, isRead: true } : m)),
    );
    navigate(`/inbox/${msg.threadId}${location.search}`, { state: { fromList: true } });
  }

  // Ouvert depuis la liste : on dépile l'historique, le retour du navigateur (geste Android) mène
  // donc aussi à la liste. Ouvert depuis ailleurs (tableau de bord, lien) : la liste remplace le fil.
  function backToList() {
    setSelectedMessageId(null);
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else navigate("/inbox", { replace: true });
  }

  // Corbeille : la suppression est définitive, elle passe par une confirmation (ConfirmDialog).
  const [permanentIds, setPermanentIds] = useState<string[] | null>(null);
  const [permanentBusy, setPermanentBusy] = useState(false);
  function requestDelete(ids = [...selectedIds]) {
    if (ids.length === 0) return;
    if (isTrashFolder) setPermanentIds(ids);
    else void bulkDelete(ids, false);
  }

  async function bulkDelete(ids = [...selectedIds], permanent = false) {
    if (ids.length === 0) return;
    try {
      await api("/api/emails/messages/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ messageIds: ids, permanent }),
      });
      const originFolderId = selectedFolderId;
      setSelectedIds(new Set());
      const deletedCurrent = messages.some(
        (m) => ids.includes(m.id) && m.threadId === threadId,
      );
      if (deletedCurrent) backToList();
      await refresh();
      if (permanent) {
        toast.success(ids.length === 1 ? "Message supprimé définitivement" : "Messages supprimés définitivement");
      } else {
        toast.success(ids.length === 1 ? "Message déplacé vers la corbeille" : "Messages déplacés vers la corbeille", {
          duration: 8000,
          action: originFolderId
            ? {
                label: "Annuler",
                onClick: () => {
                  void Promise.all(
                    ids.map((id) =>
                      api(`/api/emails/messages/${id}/move`, {
                        method: "POST",
                        body: JSON.stringify({ folderId: originFolderId }),
                      }),
                    ),
                  )
                    .then(() => {
                      toast.success(ids.length === 1 ? "Message restauré" : "Messages restaurés");
                      return refresh();
                    })
                    .catch((err: Error) => toast.error(err.message));
                },
              }
            : undefined,
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  function replyToMessage(msg: MailMessageItem) {
    // Formulaire du site sans Reply-To : l'adresse du client est dans l'encart du fil (« Répondre au client »).
    if (msg.direction !== "OUTBOUND" && isFormSender(msg.fromAddress) && !msg.replyToAddress) {
      openMessage(msg);
      return;
    }
    const to =
      msg.direction === "OUTBOUND"
        ? msg.toAddresses?.[0] ?? msg.fromAddress
        : msg.replyToAddress || msg.fromAddress;
    openCompose({
      threadId: msg.threadId,
      inReplyTo: msg.messageId,
      subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
      to,
      body: `\n\n---\nLe ${formatDate(msg.receivedAt)} à ${formatTime(msg.receivedAt)}, ${msg.fromAddress} a écrit :\n> ${msg.snippet}`,
    });
  }

  async function toggleRead(msg: MailMessageItem) {
    const read = !msg.isRead;
    try {
      await api("/api/emails/messages/bulk-flags", {
        method: "POST",
        body: JSON.stringify({ messageIds: [msg.id], read }),
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, isRead: read } : m)),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Impossible de changer le statut");
    }
  }

  async function toggleStar(msg: MailMessageItem) {
    const starred = !msg.isStarred;
    try {
      await api("/api/emails/messages/bulk-flags", {
        method: "POST",
        body: JSON.stringify({ messageIds: [msg.id], starred }),
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, isStarred: starred } : m)),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Impossible de changer le favori");
    }
  }

  async function bulkStar(starred: boolean) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      await api("/api/emails/messages/bulk-flags", {
        method: "POST",
        body: JSON.stringify({ messageIds: ids, starred }),
      });
      setMessages((prev) =>
        prev.map((m) => (selectedIds.has(m.id) ? { ...m, isStarred: starred } : m)),
      );
      setSelectedIds(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Impossible de changer les favoris");
    }
  }

  async function confirmEmptyTrash() {
    setEmptyTrashBusy(true);
    try {
      const res = await api<{ deleted: number }>("/api/emails/trash/empty", {
        method: "POST",
        body: "{}",
      });
      setSelectedIds(new Set());
      setEmptyTrashOpen(false);
      await refresh();
      toast.success(
        res.deleted > 0
          ? `Corbeille vidée (${res.deleted} message(s))`
          : "Corbeille déjà vide",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Impossible de vider la corbeille");
    } finally {
      setEmptyTrashBusy(false);
    }
  }

  const selectedFolder = folders.find((f) => f.id === selectedFolderId);
  const isTrashFolder =
    selectedFolder?.role === "TRASH" ||
    selectedFolder?.displayName?.toLowerCase().includes("corbeille") === true;

  // Un fil ouvert (depuis le tableau de bord) s'affiche même sans IMAP : ses messages sont en base.
  if (notConfigured && folders.length === 0 && !threadId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="ui-card max-w-md p-8 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary-soft)] text-[var(--primary)]">
            <FontAwesomeIcon icon={faEnvelope} className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="mt-4 text-lg font-semibold">Boîte mail non connectée</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Renseignez le serveur IMAP et le mot de passe de votre adresse pour retrouver vos échanges
            clients ici, rattachés automatiquement à chaque fiche.
          </p>
          <ButtonLink to="/settings?tab=email" className="mt-6">
            Configurer la messagerie
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {syncStatus && !syncStatus.connected && syncStatus.lastError ? (
        <div
          role="status"
          className="shrink-0 border-b border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-2 text-sm text-[var(--warning)]"
        >
          Connexion à la boîte perdue : reconnexion en cours… ({syncStatus.lastError})
        </div>
      ) : syncAge !== null && syncAge > MAIL_SYNC_STALE_MIN ? (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-1 text-sm text-[var(--warning)]"
        >
          <span>Aucune synchronisation automatique depuis {formatAgoMinutes(syncAge).replace("il y a ", "")}.</span>
          <button type="button" className="link min-h-11" onClick={() => void syncNow()}>
            Synchroniser maintenant
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--bg)]">
        <div
          className={`w-full shrink-0 border-r border-[var(--border)] bg-[var(--bg)] md:block md:w-60 ${
            !isReading && mobileFoldersOpen ? "block" : "hidden md:block"
          } ${isReading ? "hidden md:block" : ""}`}
        >
          <FolderSidebar
            lastSync={syncAge === null ? null : formatAgoMinutes(syncAge)}
            folders={folders}
            selectedId={selectedFolderId}
            onSelect={(id) => {
              setSelectedFolderId(id);
              setSelectedMessageId(null);
              setMobileFoldersOpen(false);
              // Une seule navigation : « Afficher » revient à « Tous les messages », les autres filtres restent.
              if (threadId) {
                navigate(`/inbox${withParam(location.search, "afficher", null)}`);
              } else setViewFilter("all");
            }}
            onSync={() => void syncNow()}
            onCompose={() => openCompose()}
          />
        </div>

        {!isReading ? (
          <div
            className={`min-w-0 flex-1 flex-col bg-[var(--bg)] ${mobileFoldersOpen ? "hidden md:flex" : "flex"}`}
          >
            <MessageList
              messages={messages}
              total={total}
              onLoadMore={() => void loadMore()}
              loadingMore={loadingMore}
              search={search}
              onSearchChange={setSearch}
              selectedId={selectedMessageId}
              selectedIds={selectedIds}
              onSelect={(id) => {
                const msg = messages.find((m) => m.id === id);
                if (msg) openMessage(msg);
              }}
              onToggleSelect={(id) => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              onSelectAll={(ids) => setSelectedIds(new Set(ids))}
              onClearSelection={() => setSelectedIds(new Set())}
              onBulkRead={(read) => {
                void api("/api/emails/messages/bulk-flags", {
                  method: "POST",
                  body: JSON.stringify({ messageIds: [...selectedIds], read }),
                })
                  .then(() => {
                    setMessages((prev) =>
                      prev.map((m) => (selectedIds.has(m.id) ? { ...m, isRead: read } : m)),
                    );
                    return refresh();
                  })
                  .catch((e: Error) => toast.error(e.message));
              }}
              onBulkDelete={() => requestDelete()}
              onBulkStar={(starred) => void bulkStar(starred)}
              onOpenFolders={() => setMobileFoldersOpen(true)}
              audience={audience}
              audienceCounts={audienceCounts}
              onAudienceChange={setAudience}
              viewFilter={viewFilter}
              onViewFilterChange={setViewFilter}
              onReply={replyToMessage}
              onDelete={(msg) => requestDelete([msg.id])}
              onToggleRead={(msg) => void toggleRead(msg)}
              onToggleStar={(msg) => void toggleStar(msg)}
              isTrashFolder={isTrashFolder}
              onEmptyTrash={() => setEmptyTrashOpen(true)}
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
            <ReadingPane
              threadId={threadId ?? null}
              focusMessageId={selectedMessageId}
              onBack={backToList}
              onReply={(msg) => {
                openCompose({
                  threadId: msg.threadId,
                  inReplyTo: msg.messageId,
                  subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
                  to: msg.replyToAddress || msg.fromAddress,
                  body: `\n\n---\nLe ${formatDate(msg.receivedAt)} à ${formatTime(msg.receivedAt)}, ${msg.fromAddress} a écrit :\n> ${msg.snippet}`,
                });
              }}
              onRefresh={() => void refresh()}
              onRead={(ids) => {
                notifyMailChanged();
                const idSet = new Set(ids);
                setMessages((prev) =>
                  prev.map((m) =>
                    idSet.has(m.id) || m.threadId === threadId ? { ...m, isRead: true } : m,
                  ),
                );
                setFolders((prev) =>
                  prev.map((f) =>
                    f.id === selectedFolderId
                      ? {
                          ...f,
                          unreadCount: Math.max(0, (f.unreadCount ?? 0) - ids.length),
                        }
                      : f,
                  ),
                );
              }}
            />
          </div>
        )}
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        defaults={composeDefaults}
        onSent={() => {
          setComposeOpen(false);
          void refresh();
        }}
      />

      <ConfirmDialog
        open={emptyTrashOpen}
        title="Vider la corbeille ?"
        message="Tous les messages de la corbeille seront définitivement supprimés. Cette action est irréversible."
        confirmLabel="Vider la corbeille"
        danger
        busy={emptyTrashBusy}
        onClose={() => {
          if (!emptyTrashBusy) setEmptyTrashOpen(false);
        }}
        onConfirm={() => void confirmEmptyTrash()}
      />

      <ConfirmDialog
        open={permanentIds !== null}
        title={permanentIds?.length === 1 ? "Supprimer définitivement ce message ?" : `Supprimer définitivement ${permanentIds?.length ?? 0} messages ?`}
        message="Ils sont dans la corbeille : la suppression est définitive, sur l'ERP comme sur la boîte mail. Cette action est irréversible."
        confirmLabel="Supprimer définitivement"
        danger
        busy={permanentBusy}
        onClose={() => {
          if (!permanentBusy) setPermanentIds(null);
        }}
        onConfirm={() => {
          if (!permanentIds) return;
          setPermanentBusy(true);
          void bulkDelete(permanentIds, true).finally(() => {
            setPermanentBusy(false);
            setPermanentIds(null);
          });
        }}
      />
    </div>
  );
}
