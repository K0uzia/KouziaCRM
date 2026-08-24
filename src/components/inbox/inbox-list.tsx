"use client";

import Link from "next/link";
import useSWR from "swr";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRotate } from "@fortawesome/free-solid-svg-icons";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useState } from "react";

type ThreadRow = {
  id: string;
  subject: string;
  lastMessageAt: string;
  client: { id: string; displayName: string } | null;
  preview: string;
  lastFrom: string;
};

export function InboxList() {
  const { data, error, isLoading, mutate } = useSWR<ThreadRow[]>("/api/emails");
  const [syncing, setSyncing] = useState(false);

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await fetch("/api/emails/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sync échouée");
      toast.success(`Sync IMAP : ${json.imported} importé(s), ${json.skipped} ignoré(s)`);
      await mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur sync");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Inbox</h1>
          <p className="text-muted-foreground">Échanges clients (IMAP / SMTP)</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={syncNow} disabled={syncing}>
            <FontAwesomeIcon icon={faRotate} className={syncing ? "animate-spin" : ""} />
            Synchroniser
          </Button>
          <Link
            href="/inbox/compose"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Nouveau message
          </Link>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {error && <p className="text-destructive">Impossible de charger l&apos;inbox.</p>}

      {data && data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucun message. Configurez IMAP dans `.env` puis synchronisez.
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="divide-y rounded-lg border bg-card">
          {data.map((t) => (
            <li key={t.id}>
              <Link
                href={`/inbox/${t.id}`}
                className="block px-4 py-3 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.subject}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {t.client?.displayName ?? t.lastFrom}
                      {t.preview ? ` — ${t.preview}` : ""}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {format(new Date(t.lastMessageAt), "dd MMM yyyy HH:mm", { locale: fr })}
                  </time>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
