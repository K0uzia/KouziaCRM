import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faReply,
  faStar,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { MessageBody } from "@/pages/messaging/MessageBody";
import { AttachmentList } from "@/pages/messaging/AttachmentList";
import { QuoteValidationBlock } from "@/pages/messaging/QuoteValidationBlock";
import { formatDate } from "@/lib/format";
import { senderLabel } from "@kouziacrm/email-sender";

type Props = {
  threadId: string | null;
  focusMessageId?: string | null;
  onBack: () => void;
  onReply: (msg: {
    threadId: string;
    messageId: string;
    subject: string;
    fromAddress: string;
    receivedAt: string;
    snippet: string;
  }) => void;
  onRefresh: () => void;
  onRead?: (messageIds: string[]) => void;
};

type MessageBodyPayload = { bodyText: string | null; bodyHtml: string | null };

type ThreadMessage = {
  id: string;
  messageId: string;
  fromAddress: string;
  fromName?: string | null;
  subject: string;
  receivedAt: string;
  snippet?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  isRead: boolean;
  isStarred: boolean;
  direction: string;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
};

type ThreadDetail = {
  id: string;
  subject: string;
  unreadCount: number;
  messages: ThreadMessage[];
  pendingQuotes?: Array<{
    id: string;
    number: string | null;
    totalCents: number;
    issueDate: string | null;
  }>;
  acceptanceAudits?: Array<{
    id: string;
    quoteId: string;
    signerName: string;
    source: string;
    createdAt: string;
    quote: { number: string | null };
  }>;
  quoteConfirmationHint?: boolean;
};

function bodyFromMessage(msg: ThreadMessage): MessageBodyPayload | null {
  if (msg.bodyHtml || msg.bodyText) {
    return { bodyText: msg.bodyText ?? null, bodyHtml: msg.bodyHtml ?? null };
  }
  return null;
}

export function ReadingPane({
  threadId,
  focusMessageId,
  onBack,
  onReply,
  onRefresh,
  onRead,
}: Props) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, MessageBodyPayload>>({});
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);

  useEffect(() => {
    if (!threadId) {
      setThread(null);
      return;
    }
    setLoading(true);
    setBodyError(null);
    void (async () => {
      try {
        const detail = await api<ThreadDetail>(`/api/emails/${threadId}`);
        setThread(detail);
        const focus =
          (focusMessageId && detail.messages.find((m) => m.id === focusMessageId)?.id) ||
          detail.messages[detail.messages.length - 1]?.id ||
          null;
        setExpandedId(focus);

        const seeded: Record<string, MessageBodyPayload> = {};
        for (const m of detail.messages) {
          const existing = bodyFromMessage(m);
          if (existing) seeded[m.id] = existing;
        }
        setBodies(seeded);

        const unreadIds = detail.messages.filter((m) => !m.isRead).map((m) => m.id);
        if (unreadIds.length > 0) {
          await api("/api/emails/messages/bulk-flags", {
            method: "POST",
            body: JSON.stringify({ messageIds: unreadIds, read: true }),
          });
          onRead?.(unreadIds);
          setThread((t) =>
            t
              ? {
                  ...t,
                  unreadCount: 0,
                  messages: t.messages.map((m) => ({ ...m, isRead: true })),
                }
              : t,
          );
        }

        if (focus) {
          setLoadingBody(!seeded[focus]);
          try {
            const body = await api<MessageBodyPayload>(
              `/api/emails/messages/${focus}/body?allowRemoteImages=true`,
            );
            setBodies((b) => ({ ...b, [focus]: body }));
            setBodyError(null);
          } catch (e) {
            if (!seeded[focus]) {
              setBodyError(e instanceof Error ? e.message : "Corps introuvable");
            }
          } finally {
            setLoadingBody(false);
          }
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Lecture impossible");
      } finally {
        setLoading(false);
      }
    })();
  }, [threadId, focusMessageId]);

  async function expandMessage(id: string) {
    setExpandedId(id);
    if (bodies[id]) return;
    setLoadingBody(true);
    setBodyError(null);
    try {
      const body = await api<MessageBodyPayload>(
        `/api/emails/messages/${id}/body?allowRemoteImages=true`,
      );
      setBodies((b) => ({ ...b, [id]: body }));
      await api(`/api/emails/messages/${id}/flags`, {
        method: "PATCH",
        body: JSON.stringify({ read: true }),
      });
      onRead?.([id]);
    } catch (e) {
      setBodyError(e instanceof Error ? e.message : "Corps introuvable");
      toast.error(e instanceof Error ? e.message : "Lecture impossible");
    } finally {
      setLoadingBody(false);
    }
  }

  if (!threadId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        Sélectionnez un message
      </div>
    );
  }

  if (loading || !thread) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        Chargement…
      </div>
    );
  }

  const latest = thread.messages[thread.messages.length - 1];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-3">
        <Button variant="secondary" onClick={onBack}>
          <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" />
          Retour
        </Button>
        {latest ? (
          <>
            <Button
              variant="secondary"
              onClick={() =>
                void api(`/api/emails/messages/${latest.id}/flags`, {
                  method: "PATCH",
                  body: JSON.stringify({ starred: !latest.isStarred }),
                }).then(onRefresh)
              }
            >
              <FontAwesomeIcon icon={faStar} className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                onReply({
                  threadId: thread.id,
                  messageId: latest.messageId,
                  subject: thread.subject.startsWith("Re:")
                    ? thread.subject
                    : `Re: ${thread.subject}`,
                  fromAddress: latest.fromAddress,
                  receivedAt: latest.receivedAt,
                  snippet: latest.snippet ?? "",
                })
              }
            >
              <FontAwesomeIcon icon={faReply} className="h-4 w-4" />
              Répondre
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void api(`/api/emails/messages/${latest.id}`, { method: "DELETE" })
                  .then(() => {
                    onRefresh();
                    onBack();
                  })
                  .catch((e: Error) => toast.error(e.message))
              }
            >
              <FontAwesomeIcon icon={faTrash} className="h-4 w-4" />
            </Button>
          </>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:px-8">
        <h2 className="text-lg font-semibold">{thread.subject}</h2>
        <QuoteValidationBlock
          threadId={thread.id}
          pendingQuotes={thread.pendingQuotes ?? []}
          acceptanceAudits={thread.acceptanceAudits}
          quoteConfirmationHint={thread.quoteConfirmationHint}
          onAccepted={() => {
            void (async () => {
              const detail = await api<ThreadDetail>(`/api/emails/${thread.id}`);
              setThread(detail);
              onRefresh();
            })();
          }}
        />
        <ol className="mt-4 space-y-3">
          {thread.messages.map((msg) => {
            const open = expandedId === msg.id;
            const body = bodies[msg.id] ?? (open ? bodyFromMessage(msg) : null);
            const sender = senderLabel(msg.fromName, msg.fromAddress);
            return (
              <li key={msg.id} className="rounded-lg border border-[var(--border)]">
                <button
                  type="button"
                  className="flex w-full flex-col px-4 py-3 text-left"
                  onClick={() => void expandMessage(msg.id)}
                >
                  <span className="text-sm font-medium">
                    {sender}
                    {sender !== msg.fromAddress ? (
                      <span className="font-normal text-[var(--muted)]"> · {msg.fromAddress}</span>
                    ) : null}
                    {" · "}
                    {formatDate(msg.receivedAt)}
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    {msg.direction === "OUTBOUND" ? "Envoyé" : "Reçu"}
                    {!msg.isRead ? " · Non lu" : ""}
                  </span>
                </button>
                {open && body ? (
                  <div className="border-t border-[var(--border)] px-4 pb-4">
                    {msg.attachments.length > 0 ? (
                      <AttachmentList attachments={msg.attachments} />
                    ) : null}
                    <MessageBody
                      bodyText={body.bodyText}
                      bodyHtml={body.bodyHtml}
                    />
                  </div>
                ) : null}
                {open && !body && loadingBody ? (
                  <p className="border-t border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
                    Chargement du message…
                  </p>
                ) : null}
                {open && !body && !loadingBody && bodyError ? (
                  <p className="border-t border-[var(--border)] px-4 py-3 text-sm text-[var(--danger)]">
                    {bodyError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
