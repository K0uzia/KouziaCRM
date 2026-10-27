import { isNetworkFailure } from "@/lib/network";
import { OfflineGuard } from "@/components/ui/OfflineGuard";
import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faPaperclip,
  faReply,
  faStar,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { ClientPrefill } from "@/components/clients/ClientForm";
import { MessageBody } from "@/pages/messaging/MessageBody";
import { AttachmentList } from "@/pages/messaging/AttachmentList";
import { QuoteValidationBlock } from "@/pages/messaging/QuoteValidationBlock";
import { FormSubmissionPanel, type FormSubmission } from "@/pages/messaging/FormSubmissionPanel";
import { SenderClientPanel, type SenderSuggestion } from "@/pages/messaging/SenderClientPanel";
import { formatMailDateTime } from "@/lib/format";
import { Link } from "react-router-dom";
import { senderLabel } from "@kouzia-erp/email-sender";
import { formProspectName } from "@/pages/messaging/sender";

type Props = {
  threadId: string | null;
  focusMessageId?: string | null;
  onBack: () => void;
  onReply: (msg: {
    threadId: string;
    messageId: string;
    subject: string;
    fromAddress: string;
    replyToAddress?: string | null;
    receivedAt: string;
    snippet: string;
  }) => void;
  onRefresh: () => void;
  onRead?: (messageIds: string[]) => void;
  /** Corbeille affichée : la suppression est définitive, elle passe par une confirmation (audit du 27/10/2026). */
  permanentDelete?: boolean;
};

type MessageBodyPayload = {
  bodyText: string | null;
  bodyHtml: string | null;
  attachments?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
  /** Formulaire du site sans client correspondant : fiche proposée, jamais créée d'office. */
  formLead?: ClientPrefill | null;
};

type ThreadMessage = {
  id: string;
  messageId: string;
  fromAddress: string;
  fromName?: string | null;
  replyToAddress?: string | null;
  subject: string;
  receivedAt: string;
  snippet?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments?: boolean;
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
  client?: { id: string; displayName: string } | null;
  formSubmission?: FormSubmission | null;
  /** Expéditeur sans client : fiche à créer ou client à associer. */
  senderSuggestion?: SenderSuggestion | null;
};

/** Expéditeur technique du formulaire du site (Web3Forms) : on ne lui répond jamais. */
const FORM_SENDER = /@(?:[a-z0-9-]+\.)*web3forms\.com$/i;

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
  permanentDelete = false,
}: Props) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, MessageBodyPayload>>({});
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  useEffect(() => {
    if (!threadId) {
      setThread(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
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
        // Marquer comme lu ne bloque jamais la lecture : hors ligne, ce sera fait à la prochaine ouverture en ligne.
        if (unreadIds.length > 0) {
          try {
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
          } catch {
            /* hors ligne ou refus : le fil reste affiché, non lu */
          }
        }

        if (focus) {
          setLoadingBody(!seeded[focus]);
          try {
            const body = await api<MessageBodyPayload>(
              `/api/emails/messages/${focus}/body?allowRemoteImages=true`,
            );
            setBodies((b) => ({ ...b, [focus]: body }));
            if (body.attachments) {
              setThread((t) =>
                t
                  ? {
                      ...t,
                      messages: t.messages.map((m) =>
                        m.id === focus ? { ...m, attachments: body.attachments ?? m.attachments } : m,
                      ),
                    }
                  : t,
              );
            }
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
        setThread(null);
        // Le message brut de l'API peut être technique (« Not found ») : libellé français constant.
        setLoadError(
          isNetworkFailure(e)
            ? "Cette conversation n'est pas sur l'appareil : seuls les messages des 90 derniers jours sont copiés. Elle s'ouvrira au retour du réseau."
            : "Impossible d'ouvrir cette conversation : elle a peut-être été supprimée.",
        );
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
      if (body.attachments) {
        setThread((t) =>
          t
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === id ? { ...m, attachments: body.attachments ?? m.attachments } : m,
                ),
              }
            : t,
        );
      }
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

  const backButton = (
    <Button variant="secondary" onClick={onBack}>
      <FontAwesomeIcon icon={faArrowLeft} className="h-4 w-4" aria-hidden />
      Retour
    </Button>
  );

  // Chargement ou fil introuvable : le retour à la liste reste disponible.
  if (loading || !thread) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-[var(--border)] p-3">{backButton}</div>
        <div
          role={loadError ? "alert" : "status"}
          className={`flex flex-1 items-center justify-center p-6 text-center text-sm ${loadError ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}
        >
          {loadError && !loading ? loadError : "Chargement…"}
        </div>
      </div>
    );
  }

  const latest = thread.messages[thread.messages.length - 1];
  const form = thread.formSubmission ?? null;
  // Message du formulaire : réponse à l'adresse du client (ou saisie dans le formulaire), jamais à Web3Forms.
  const replyAddress = (msg: ThreadMessage) =>
    form?.replyTo && FORM_SENDER.test(msg.fromAddress) ? form.replyTo : msg.replyToAddress;
  const replyToForm = (to: string) => {
    const msg = thread.messages.find((m) => m.id === form?.messageId) ?? latest;
    if (!msg) return;
    onReply({
      threadId: thread.id,
      messageId: msg.messageId,
      subject: thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`,
      fromAddress: to,
      replyToAddress: to,
      receivedAt: msg.receivedAt,
      snippet: msg.snippet ?? "",
    });
  };

  const deleteLatest = () => {
    if (!latest) return;
    void api<{ restoreFolderId: string | null }>(`/api/emails/messages/${latest.id}`, { method: "DELETE" })
      .then((res) => {
        onRefresh();
        onBack();
        const folderId = res?.restoreFolderId;
        toast.success(folderId ? "Message mis à la corbeille" : "Message supprimé", {
          action: folderId
            ? {
                label: "Annuler",
                onClick: () =>
                  void api(`/api/emails/messages/${latest.id}/move`, {
                    method: "POST",
                    body: JSON.stringify({ folderId }),
                  })
                    .then(() => {
                      onRefresh();
                      toast.success("Message remis dans son dossier");
                    })
                    .catch((e: Error) => toast.error(e.message)),
              }
            : undefined,
        });
      })
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Corbeille : suppression définitive (serveur de messagerie compris), confirmée comme la suppression groupée. */}
      <ConfirmDialog
        open={confirmDelete}
        title="Supprimer définitivement ?"
        message="Ce message sera supprimé du serveur de messagerie. Cette action est irréversible."
        confirmLabel="Supprimer définitivement"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          deleteLatest();
        }}
      />
      {/* En-tête collant : retour, favori, suppression ; « Répondre » ici sur grand écran. */}
      <div className="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] p-2 md:p-3">
        {backButton}
        {latest ? (
          <OfflineGuard className="contents">
            <span className="flex-1" />
            <span className="hidden md:block">
            <Button
              variant="secondary"
              onClick={() => onReply({
                  threadId: thread.id,
                  messageId: latest.messageId,
                  subject: thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`,
                  fromAddress: latest.fromAddress,
                  replyToAddress: replyAddress(latest),
                  receivedAt: latest.receivedAt,
                  snippet: latest.snippet ?? "",
                })}
            >
              <FontAwesomeIcon icon={faReply} className="h-4 w-4" aria-hidden />
              Répondre
            </Button>
            </span>
            <Button
              variant="ghost"
              aria-label={latest.isStarred ? "Retirer des favoris" : "Ajouter aux favoris"}
              aria-pressed={latest.isStarred}
              onClick={() =>
                void api(`/api/emails/messages/${latest.id}/flags`, {
                  method: "PATCH",
                  body: JSON.stringify({ starred: !latest.isStarred }),
                }).then(onRefresh)
              }
            >
              <FontAwesomeIcon
                icon={faStar}
                className={`h-4 w-4 ${latest.isStarred ? "text-[var(--warning)]" : ""}`}
                aria-hidden
              />
            </Button>
            <Button
              variant="ghost"
              aria-label="Supprimer le message"
              onClick={() => (permanentDelete ? setConfirmDelete(true) : deleteLatest())}
            >
              <FontAwesomeIcon icon={faTrash} className="h-4 w-4" aria-hidden />
            </Button>
          </OfflineGuard>
        ) : null}
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-4 md:px-8">
        <h2 className="text-lg font-semibold leading-snug break-words">{thread.subject}</h2>
        {form ? (
          <FormSubmissionPanel form={form} onReply={replyToForm} />
        ) : thread.client ? (
          <Link to={`/clients/${thread.client.id}`} className="link mt-1 inline-flex min-h-11 items-center text-sm">
            Client : {thread.client.displayName}
          </Link>
        ) : thread.senderSuggestion ? (
          <SenderClientPanel
            threadId={thread.id}
            suggestion={thread.senderSuggestion}
            onLinked={() => {
              void (async () => {
                setThread(await api<ThreadDetail>(`/api/emails/${thread.id}`));
                onRefresh();
              })();
            }}
          />
        ) : null}
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
            // Formulaire du site : le prospect (Reply-To, nom dans le corps) est l'expéditeur réel.
            const fromForm = msg.direction !== "OUTBOUND" && FORM_SENDER.test(msg.fromAddress);
            const viaForm = msg.direction !== "OUTBOUND" && (Boolean(msg.replyToAddress) || fromForm);
            // Jamais l'adresse technique Web3Forms : Reply-To, sinon l'adresse du client ou saisie (encart du haut).
            const senderAddress = viaForm ? (msg.replyToAddress ?? (fromForm ? form?.replyTo : null) ?? msg.fromAddress) : msg.fromAddress;
            const sender = viaForm
              ? ((fromForm ? form?.client?.displayName : null) ?? formProspectName(msg.bodyText ?? msg.snippet) ?? senderLabel(null, senderAddress))
              : senderLabel(msg.fromName, msg.fromAddress);
            return (
              <li key={msg.id} className="rounded-lg border border-[var(--border)]">
                <button
                  type="button"
                  aria-expanded={open}
                  className="flex w-full min-w-0 flex-col px-4 py-3 text-left"
                  onClick={() => void expandMessage(msg.id)}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{sender}</span>
                    <time dateTime={msg.receivedAt} className="shrink-0 whitespace-nowrap text-xs text-[var(--muted)]">
                      {formatMailDateTime(msg.receivedAt)}
                    </time>
                  </span>
                  {sender !== senderAddress ? (
                    <span className="truncate text-xs text-[var(--muted)]">{senderAddress}</span>
                  ) : null}
                  {viaForm ? (
                    <span className="text-xs text-[var(--muted)]">via le formulaire kouzia.com</span>
                  ) : null}
                  {!open && msg.snippet ? (
                    <span className="mt-0.5 truncate text-sm text-[var(--muted)]">{msg.snippet}</span>
                  ) : null}
                  <span className="text-xs text-[var(--muted)]">
                    {msg.direction === "OUTBOUND" ? "Envoyé" : "Reçu"}
                    {" · "}
                    {formatMailDateTime(msg.receivedAt)}
                    {!msg.isRead ? " · Non lu" : ""}
                    {msg.attachments.length > 0 || msg.hasAttachments ? (
                      <>
                        {" · "}
                        <FontAwesomeIcon icon={faPaperclip} className="h-3 w-3" aria-hidden />
                        {msg.attachments.length > 0
                          ? ` ${msg.attachments.length} PJ`
                          : " Pièce(s) jointe(s)"}
                      </>
                    ) : null}
                  </span>
                </button>
                {open && body ? (
                  <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
                    {msg.attachments.length > 0 ? (
                      <AttachmentList attachments={msg.attachments} />
                    ) : null}
                    {form?.messageId === msg.id ? (
                      // Champs déjà présentés en liste dans l'encart du haut : le texte reçu reste consultable.
                      <details>
                        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-[var(--muted)] hover:text-[var(--text)]">
                          Voir le message reçu tel quel
                        </summary>
                        <MessageBody bodyText={body.bodyText} bodyHtml={body.bodyHtml} />
                      </details>
                    ) : (
                      <MessageBody bodyText={body.bodyText} bodyHtml={body.bodyHtml} />
                    )}
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
      {latest ? (
        <OfflineGuard className="border-t border-[var(--border)] bg-[var(--bg)] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          <Button className="w-full" onClick={() => onReply({
                  threadId: thread.id,
                  messageId: latest.messageId,
                  subject: thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`,
                  fromAddress: latest.fromAddress,
                  replyToAddress: replyAddress(latest),
                  receivedAt: latest.receivedAt,
                  snippet: latest.snippet ?? "",
                })}>
            <FontAwesomeIcon icon={faReply} className="h-4 w-4" aria-hidden />
            Répondre
          </Button>
        </OfflineGuard>
      ) : null}
    </div>
  );
}
