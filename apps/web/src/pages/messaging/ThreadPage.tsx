import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Textarea } from "@/components/ui/Field";
import { AttachmentList } from "./AttachmentList";
import { MessageBody } from "./MessageBody";
import { QuickActions } from "./QuickActions";
import { QuoteValidationBlock } from "./QuoteValidationBlock";
import { senderLabel } from "@kouziacrm/email-sender";

export function ThreadPage() {
  const { threadId } = useParams();
  const [thread, setThread] = useState<{
    id?: string;
    subject: string;
    clientId?: string | null;
    client?: { id: string; displayName: string } | null;
    participants?: string[];
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
    messages: Array<{
      id: string;
      messageId: string;
      fromAddress: string;
      fromName?: string | null;
      toAddresses?: string[];
      bodyText: string | null;
      bodyHtml: string | null;
      receivedAt: string;
      direction: string;
      subject?: string;
      attachments?: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
    }>;
  } | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!threadId) return;
    const t = await api<NonNullable<typeof thread>>(`/api/emails/${threadId}`);
    setThread(t);
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, [threadId]);

  if (!thread) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  const lastInbound = [...thread.messages].reverse().find((m) => m.direction === "INBOUND");
  const lastOutbound = [...thread.messages].reverse().find((m) => m.direction === "OUTBOUND");
  const lastMessage = thread.messages[thread.messages.length - 1];
  const ourAddress = lastOutbound?.fromAddress?.toLowerCase() ?? "";
  const replyTo =
    lastInbound?.fromAddress ||
    (lastOutbound?.toAddresses?.[0] ?? "") ||
    (thread.participants ?? []).find((p) => p && p.toLowerCase() !== ourAddress) ||
    "";

  function quoteText(text: string | null): string {
    if (!text?.trim()) return "";
    return text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    if (!threadId || !replyTo) {
      toast.error("Destinataire introuvable pour la réponse");
      return;
    }
    setBusy(true);
    try {
      const subject = thread!.subject.startsWith("Re:")
        ? thread!.subject
        : `Re: ${thread!.subject}`;
      const quote = quoteText(lastMessage?.bodyText ?? null);
      const body = quote ? `${replyBody}\n\n${quote}` : replyBody;
      await api("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({
          to: replyTo,
          subject,
          body,
          threadId,
          inReplyTo: lastMessage?.messageId,
          clientId: thread!.clientId ?? thread!.client?.id,
        }),
      });
      toast.success("Réponse en file d'envoi");
      setReplyBody("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Link to="/inbox" className="text-sm text-[var(--primary)] hover:underline">
        ← Messages
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{thread.subject}</h1>
      {thread.client ? (
        <p className="text-sm text-[var(--muted)]">
          Client :{" "}
          <Link to={`/clients/${thread.client.id}`}>
            <Button type="button" variant="secondary" className="ml-1 h-8 text-xs">
              {thread.client.displayName}
            </Button>
          </Link>
        </p>
      ) : null}
      {threadId && thread.id ? (
        <QuoteValidationBlock
          threadId={thread.id}
          pendingQuotes={thread.pendingQuotes ?? []}
          acceptanceAudits={thread.acceptanceAudits}
          quoteConfirmationHint={thread.quoteConfirmationHint}
          onAccepted={() => void load()}
        />
      ) : null}
      <div className="space-y-3">
        {thread.messages.map((m) => (
          <Card key={m.id} className="p-4 text-sm">
            <p className="text-xs text-[var(--muted)]">
              {m.direction === "OUTBOUND" ? "Envoyé" : "Reçu"} ·{" "}
              {senderLabel(m.fromName, m.fromAddress)} · {formatDate(m.receivedAt)}
            </p>
            <MessageBody bodyText={m.bodyText} bodyHtml={m.bodyHtml} />
            {m.attachments ? <AttachmentList attachments={m.attachments} /> : null}
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <QuickActions
          threadId={threadId!}
          clientId={thread.clientId ?? thread.client?.id}
          clientName={thread.client?.displayName}
          subject={thread.subject}
          onRefresh={() => void load()}
        />
        <form onSubmit={sendReply} className="mt-4 space-y-3">
          <p className="text-sm font-medium">Répondre</p>
          <p className="text-xs text-[var(--muted)]">À : {replyTo || "-"}</p>
          <Field label="Message">
            <Textarea
              required
              rows={6}
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              placeholder="Votre réponse…"
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !replyTo}>
              {busy ? "Envoi…" : "Envoyer la réponse"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
