import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Field, Input, Textarea } from "@/components/ui/Field";

type Decl = {
  id: string;
  periodKey: string;
  amountDueCents: number;
  encaisseCents: number;
  status: string;
  deadline: string;
  paidAt: string | null;
};

export function BanquePage() {
  const [rows, setRows] = useState<Decl[]>([]);

  useEffect(() => {
    api<Decl[]>("/api/urssaf/declarations")
      .then(setRows)
      .catch((e: Error) => toast.error(e.message));
  }, []);

  return (
    <div>
      <PageHeader
        title="URSSAF"
        subtitle="Historique des déclarations et virements marqués payés"
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="Aucune déclaration"
            hint="Elles apparaissent quand vous marquez une échéance comme payée."
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg)]/80 text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Période</th>
                <th className="px-4 py-3 font-medium">Encaissé</th>
                <th className="px-4 py-3 font-medium">Dû</th>
                <th className="px-4 py-3 font-medium">Statut</th>
                <th className="px-4 py-3 font-medium">Échéance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="px-4 py-3 font-medium">{r.periodKey}</td>
                  <td className="px-4 py-3 tabular-nums">{formatEUR(r.encaisseCents)}</td>
                  <td className="px-4 py-3 tabular-nums">{formatEUR(r.amountDueCents)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={r.status === "PAID" ? "green" : "amber"}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-3">{formatDate(r.deadline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

type Thread = {
  id: string;
  subject: string;
  lastMessageAt: string;
  preview: string;
  lastFrom: string;
  client: { id: string; displayName: string } | null;
};

export function InboxPage() {
  const [threads, setThreads] = useState<Thread[]>([]);

  async function load() {
    setThreads(await api<Thread[]>("/api/emails"));
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  async function sync() {
    try {
      await api("/api/emails/sync", { method: "POST" });
      toast.success("Boîte synchronisée");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur sync");
    }
  }

  return (
    <div>
      <PageHeader
        title="Emails"
        subtitle="Échanges clients (SMTP / IMAP)"
        actions={
          <>
            <Button variant="secondary" onClick={() => void sync()}>
              Synchroniser
            </Button>
            <Link
              to="/inbox/compose"
              className="inline-flex h-10 items-center rounded-[var(--radius)] bg-[var(--primary)] px-4 text-sm font-medium text-white"
            >
              Écrire
            </Link>
          </>
        }
      />
      <Card>
        {threads.length === 0 ? (
          <EmptyState title="Aucun message" hint="Configurez IMAP ou écrivez un email." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {threads.map((t) => (
              <li key={t.id}>
                <Link
                  to={`/inbox/${t.id}`}
                  className="block px-4 py-3 hover:bg-[var(--bg)]"
                >
                  <div className="flex justify-between gap-3 text-sm">
                    <span className="font-medium">{t.subject}</span>
                    <span className="shrink-0 text-[var(--muted)]">
                      {formatDate(t.lastMessageAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {t.client?.displayName ?? t.lastFrom}  -  {t.preview}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function InboxThreadPage() {
  const { threadId } = useParams();
  const [thread, setThread] = useState<{
    subject: string;
    messages: Array<{
      id: string;
      fromAddress: string;
      bodyText: string | null;
      receivedAt: string;
      direction: string;
    }>;
  } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    api<NonNullable<typeof thread>>(`/api/emails/${threadId}`)
      .then(setThread)
      .catch((e: Error) => toast.error(e.message));
  }, [threadId]);

  if (!thread) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  return (
    <div className="space-y-4">
      <Link to="/inbox" className="text-sm text-[var(--primary)] hover:underline">
        ← Emails
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{thread.subject}</h1>
      <div className="space-y-3">
        {thread.messages.map((m) => (
          <Card key={m.id} className="p-4 text-sm">
            <p className="text-xs text-[var(--muted)]">
              {m.direction === "OUTBOUND" ? "Envoyé" : "Reçu"} · {m.fromAddress} ·{" "}
              {formatDate(m.receivedAt)}
            </p>
            <pre className="mt-2 whitespace-pre-wrap font-[family-name:var(--font)]">
              {m.bodyText}
            </pre>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function ComposePage() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ threadId: string }>("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({ to, subject, body }),
      });
      toast.success("Message envoyé");
      window.location.href = `/inbox/${res.threadId}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Nouveau message" />
      <Card className="p-5">
        <form onSubmit={send} className="space-y-4">
          <Field label="Destinataire">
            <Input type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Sujet">
            <Input required value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea required rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Link
              to="/inbox"
              className="inline-flex h-10 items-center rounded-[var(--radius)] border px-4 text-sm"
            >
              Annuler
            </Link>
            <Button type="submit" disabled={busy}>
              {busy ? "Envoi…" : "Envoyer"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
