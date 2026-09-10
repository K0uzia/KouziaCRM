import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { FolderSidebar } from "@/pages/messaging/FolderSidebar";
import { MessageList } from "@/pages/messaging/MessageList";
import { ReadingPane } from "@/pages/messaging/ReadingPane";
import { ComposeModal } from "@/pages/messaging/ComposeModal";
import { useInboxSync } from "@/pages/messaging/useInboxSync";
import { useMailNotifications } from "@/pages/messaging/useMailNotifications";

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
    client?: { id: string; displayName: string } | null;
  };
};

export type SyncStatus = {
  connected: boolean;
  idleActive: boolean;
  lastError?: string | null;
  lastSyncAt?: string | null;
};

export function MailLayout() {
  const navigate = useNavigate();
  const { threadId } = useParams<{ threadId?: string }>();
  const isReading = Boolean(threadId);

  const [folders, setFolders] = useState<MailFolderItem[]>([]);
  const [virtualFolders, setVirtualFolders] = useState<MailFolderItem[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MailMessageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [audience, setAudience] = useState<"all" | "clients" | "external">("all");
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

  const loadFolders = useCallback(async () => {
    const data = await api<{
      folders: MailFolderItem[];
      virtualFolders: MailFolderItem[];
      syncStatus: SyncStatus;
    }>("/api/emails/folders");
    setFolders(data.folders);
    setVirtualFolders(data.virtualFolders);
    setSyncStatus(data.syncStatus);
    if (!selectedFolderId) {
      const inbox = data.folders.find((f) => f.role === "INBOX");
      if (inbox) setSelectedFolderId(inbox.id);
      else if (data.virtualFolders[0]) setSelectedFolderId(data.virtualFolders[0].id);
    }
  }, [selectedFolderId]);

  const loadMessages = useCallback(async () => {
    if (!selectedFolderId) return;
    const params = new URLSearchParams();
    if (selectedFolderId.startsWith("virtual:")) {
      params.set("virtual", selectedFolderId.replace("virtual:", ""));
    } else {
      params.set("folderId", selectedFolderId);
    }
    if (search.trim()) params.set("q", search.trim());
    if (audience !== "all") params.set("audience", audience);
    params.set("take", "50");
    const data = await api<{
      messages: MailMessageItem[];
      total: number;
      audienceCounts: { all: number; clients: number; external: number };
    }>(`/api/emails/messages?${params}`);
    setMessages(data.messages);
    setTotal(data.total);
    setAudienceCounts(data.audienceCounts);
  }, [selectedFolderId, search, audience]);

  const refresh = useCallback(async () => {
    await loadFolders();
    await loadMessages();
  }, [loadFolders, loadMessages]);

  useEffect(() => {
    void loadFolders().catch((e: Error) => toast.error(e.message));
  }, [loadFolders]);

  useEffect(() => {
    void loadMessages().catch((e: Error) => toast.error(e.message));
  }, [loadMessages]);

  useInboxSync(refresh);
  useMailNotifications(refresh, syncStatus);

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
    navigate(`/inbox/${msg.threadId}`);
  }

  function backToList() {
    setSelectedMessageId(null);
    navigate("/inbox");
  }

  async function bulkDelete(ids = [...selectedIds], permanent = false) {
    if (ids.length === 0) return;
    try {
      await api("/api/emails/messages/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ messageIds: ids, permanent }),
      });
      setSelectedIds(new Set());
      const deletedCurrent = messages.some(
        (m) => ids.includes(m.id) && m.threadId === threadId,
      );
      if (deletedCurrent) backToList();
      await refresh();
      toast.success(
        permanent
          ? ids.length === 1
            ? "Message supprimé définitivement"
            : "Messages supprimés définitivement"
          : ids.length === 1
            ? "Message déplacé vers la corbeille"
            : "Messages déplacés vers la corbeille",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  function replyToMessage(msg: MailMessageItem) {
    const to =
      msg.direction === "OUTBOUND"
        ? msg.toAddresses?.[0] ?? msg.fromAddress
        : msg.fromAddress;
    openCompose({
      threadId: msg.threadId,
      inReplyTo: msg.messageId,
      subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
      to,
      body: `\n\n---\nLe ${msg.receivedAt}, ${msg.fromAddress} a écrit :\n> ${msg.snippet}`,
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

  async function emptyTrash() {
    if (!window.confirm("Vider la corbeille ? Les messages seront définitivement supprimés.")) {
      return;
    }
    try {
      const res = await api<{ deleted: number }>("/api/emails/trash/empty", {
        method: "POST",
        body: "{}",
      });
      setSelectedIds(new Set());
      await refresh();
      toast.success(
        res.deleted > 0
          ? `Corbeille vidée (${res.deleted} message(s))`
          : "Corbeille déjà vide",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Impossible de vider la corbeille");
    }
  }

  const selectedFolder = [...folders, ...virtualFolders].find((f) => f.id === selectedFolderId);
  const isTrashFolder =
    selectedFolder?.role === "TRASH" ||
    selectedFolder?.displayName?.toLowerCase().includes("corbeille") === true;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {syncStatus && !syncStatus.connected && syncStatus.lastError ? (
        <div
          role="status"
          className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          Connexion à la boîte perdue : reconnexion en cours… ({syncStatus.lastError})
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--bg)]">
        <div
          className={`w-full shrink-0 border-r border-[var(--border)] bg-[var(--bg)] md:block md:w-60 ${
            !isReading && mobileFoldersOpen ? "block" : "hidden md:block"
          } ${isReading ? "hidden md:block" : ""}`}
        >
          <FolderSidebar
            folders={[...folders, ...virtualFolders]}
            selectedId={selectedFolderId}
            onSelect={(id) => {
              setSelectedFolderId(id);
              setSelectedMessageId(null);
              setMobileFoldersOpen(false);
              if (threadId) navigate("/inbox");
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
              onBulkDelete={() => void bulkDelete(undefined, isTrashFolder)}
              onBulkStar={(starred) => void bulkStar(starred)}
              onOpenFolders={() => setMobileFoldersOpen(true)}
              audience={audience}
              audienceCounts={audienceCounts}
              onAudienceChange={setAudience}
              onReply={replyToMessage}
              onDelete={(msg) => void bulkDelete([msg.id], isTrashFolder)}
              onToggleRead={(msg) => void toggleRead(msg)}
              onToggleStar={(msg) => void toggleStar(msg)}
              isTrashFolder={isTrashFolder}
              onEmptyTrash={() => void emptyTrash()}
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
                  to: msg.fromAddress,
                  body: `\n\n---\nLe ${msg.receivedAt}, ${msg.fromAddress} a écrit :\n> ${msg.snippet}`,
                });
              }}
              onRefresh={() => void refresh()}
              onRead={(ids) => {
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
    </div>
  );
}
