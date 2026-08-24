"use client";

import Link from "next/link";
import useSWR from "swr";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Skeleton } from "@/components/ui/skeleton";
import { ComposeForm } from "@/components/inbox/compose-form";

type ThreadDetail = {
  id: string;
  subject: string;
  client: { id: string; displayName: string } | null;
  messages: Array<{
    id: string;
    direction: "INBOUND" | "OUTBOUND";
    fromAddress: string;
    toAddresses: string[];
    subject: string;
    bodyText: string | null;
    receivedAt: string;
    messageId: string;
  }>;
};

export function ThreadView({ threadId }: { threadId: string }) {
  const { data, error, isLoading, mutate } = useSWR<ThreadDetail>(`/api/emails/${threadId}`);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-destructive">Thread introuvable.</p>;
  }

  const last = data.messages[data.messages.length - 1];
  const replyTo =
    last?.direction === "INBOUND"
      ? last.fromAddress
      : last?.toAddresses?.[0] || "";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/inbox" className="text-sm text-primary hover:underline">
          ← Inbox
        </Link>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-2xl text-primary">
          {data.subject}
        </h1>
        {data.client && (
          <p className="text-sm text-muted-foreground">
            Client :{" "}
            <Link href={`/clients/${data.client.id}`} className="text-primary hover:underline">
              {data.client.displayName}
            </Link>
          </p>
        )}
      </div>

      <div className="space-y-3">
        {data.messages.map((m) => (
          <article
            key={m.id}
            className={`rounded-lg border p-4 transition-colors ${
              m.direction === "OUTBOUND" ? "border-primary/20 bg-primary/5" : "bg-card"
            }`}
          >
            <header className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {m.direction === "OUTBOUND" ? "Vous" : m.fromAddress} → {m.toAddresses.join(", ")}
              </span>
              <time>{format(new Date(m.receivedAt), "dd MMM yyyy HH:mm", { locale: fr })}</time>
            </header>
            <pre className="whitespace-pre-wrap font-sans text-sm">{m.bodyText || "(vide)"}</pre>
          </article>
        ))}
      </div>

      <ComposeForm
        defaultTo={replyTo}
        defaultSubject={data.subject.startsWith("Re:") ? data.subject : `Re: ${data.subject}`}
        threadId={data.id}
        inReplyTo={last?.messageId}
        onSent={() => mutate()}
      />
    </div>
  );
}
