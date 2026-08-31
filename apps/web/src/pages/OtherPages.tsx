import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import {
  EMAIL_TEMPLATES,
  applyTemplate,
  type EmailTemplateId,
} from "@/lib/email-templates";

type Decl = {
  id: string;
  periodKey: string;
  amountDueCents: number;
  encaisseCents: number;
  status: string;
  deadline: string;
  paidAt: string | null;
  paymentRef: string | null;
};

type Echeance = {
  status: "paid" | "due" | "late" | "clear";
  periodKey: string;
  periodLabel: string;
  deadline: string;
  encaisseCents: number;
  amountDueCents: number;
  paidAt: string | null;
};

const declStatusLabel: Record<string, string> = {
  DUE: "À payer",
  PAID: "Payée",
  LATE: "En retard",
};

export function UrssafPage() {
  const [rows, setRows] = useState<Decl[]>([]);
  const [echeance, setEcheance] = useState<Echeance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markOpen, setMarkOpen] = useState(false);
  const [paymentRef, setPaymentRef] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [decls, dashboard] = await Promise.all([
      api<Decl[]>("/api/urssaf/declarations"),
      api<{ echeance: Echeance }>("/api/dashboard"),
    ]);
    setRows(decls);
    setEcheance(dashboard.echeance);
    setError(null);
  }

  useEffect(() => {
    load()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function markPaid() {
    setBusy(true);
    try {
      await api("/api/urssaf/mark-paid", {
        method: "POST",
        body: JSON.stringify({
          periodKey: echeance?.periodKey,
          paymentRef: paymentRef.trim() || undefined,
        }),
      });
      toast.success("Échéance enregistrée comme payée");
      setMarkOpen(false);
      setPaymentRef("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const settled = echeance?.status === "paid" || echeance?.status === "clear";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Historique URSSAF"
        subtitle="Ce que vous avez déclaré, et ce qui reste à régler"
      />

      {echeance ? (
        <Card
          className={`p-5 ${
            echeance.status === "late" ? "border-[var(--danger)]/40" : ""
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs text-[var(--muted)]">Échéance en cours</p>
              <p className="mt-1 text-base font-semibold">{echeance.periodLabel}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {formatEUR(echeance.encaisseCents)} encaissés · à déclarer avant le{" "}
                {formatDate(echeance.deadline)}
              </p>
              {echeance.paidAt ? (
                <p className="mt-1 text-xs text-[var(--success)]">
                  Réglée le {formatDate(echeance.paidAt)}
                </p>
              ) : null}
            </div>
            <div className="text-right">
              <p className="tabular-nums text-lg font-semibold">
                {formatEUR(echeance.amountDueCents)}
              </p>
              {!settled ? (
                <Button className="mt-2" onClick={() => setMarkOpen(true)}>
                  Marquer comme payée
                </Button>
              ) : (
                <Badge tone="green">
                  {echeance.status === "paid" ? "Réglée" : "Rien à payer"}
                </Badge>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        {loading ? (
          <p className="p-4 text-sm text-[var(--muted)]">Chargement…</p>
        ) : error ? (
          <p className="p-4 text-sm text-[var(--danger)]">{error}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Aucune déclaration enregistrée"
            hint="Elles apparaissent ici dès que vous marquez une échéance comme payée."
          />
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th className="nowrap">Période</th>
                  <th className="nowrap">Encaissé</th>
                  <th className="nowrap">Dû</th>
                  <th className="nowrap">Statut</th>
                  <th className="nowrap">Échéance</th>
                  <th className="nowrap">Référence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap font-medium">{r.periodKey}</td>
                    <td className="nowrap tabular-nums">{formatEUR(r.encaisseCents)}</td>
                    <td className="nowrap tabular-nums">{formatEUR(r.amountDueCents)}</td>
                    <td className="nowrap">
                      <Badge tone={r.status === "PAID" ? "green" : "amber"}>
                        {declStatusLabel[r.status] ?? r.status}
                      </Badge>
                    </td>
                    <td className="nowrap">{formatDate(r.deadline)}</td>
                    <td className="nowrap text-[var(--muted)]">{r.paymentRef ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={markOpen}
        onClose={() => !busy && setMarkOpen(false)}
        title="Marquer l'échéance comme payée"
        description={
          echeance
            ? `${echeance.periodLabel} : ${formatEUR(echeance.amountDueCents)}`
            : undefined
        }
      >
        <div className="space-y-4">
          <Field label="Référence de paiement (facultative)">
            <Input
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              placeholder="Numéro de télépaiement, référence de virement…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setMarkOpen(false)}
            >
              Annuler
            </Button>
            <Button type="button" disabled={busy} onClick={() => void markPaid()}>
              {busy ? "…" : "Enregistrer"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** @deprecated utiliser UrssafPage */
export const BanquePage = UrssafPage;

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
  const [loading, setLoading] = useState(true);

  async function load() {
    setThreads(await api<Thread[]>("/api/emails"));
  }

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
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
        {loading ? (
          <p className="p-4 text-sm text-[var(--muted)]">Chargement…</p>
        ) : threads.length === 0 ? (
          <EmptyState
            title="Aucun message"
            hint="Configurez IMAP ou écrivez un email depuis Composer."
          />
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
    clientId?: string | null;
    client?: { id: string; displayName: string } | null;
    participants?: string[];
    messages: Array<{
      id: string;
      messageId: string;
      fromAddress: string;
      toAddresses?: string[];
      bodyText: string | null;
      receivedAt: string;
      direction: string;
      subject?: string;
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
      await api("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({
          to: replyTo,
          subject,
          body: replyBody,
          threadId,
          inReplyTo: lastMessage?.messageId,
          clientId: thread!.clientId ?? thread!.client?.id,
        }),
      });
      toast.success("Réponse envoyée");
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
        ← Emails
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{thread.subject}</h1>
      {thread.client ? (
        <p className="text-sm text-[var(--muted)]">
          Client :{" "}
          <Link className="text-[var(--primary)] hover:underline" to={`/clients/${thread.client.id}`}>
            {thread.client.displayName}
          </Link>
        </p>
      ) : null}
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

      <Card className="p-5">
        <form onSubmit={sendReply} className="space-y-3">
          <p className="text-sm font-medium">Répondre</p>
          <p className="text-xs text-[var(--muted)]">
            À : {replyTo || "-"}
          </p>
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

type ClientOpt = {
  id: string;
  displayName: string;
  email?: string | null;
  clientNumber?: string | null;
};

export function ComposePage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [mode, setMode] = useState<"client" | "other">("client");
  const [clientId, setClientId] = useState(search.get("clientId") ?? "");
  const [to, setTo] = useState("");
  const [templateId, setTemplateId] = useState<EmailTemplateId>(
    (search.get("template") as EmailTemplateId) || "blank",
  );
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<ClientOpt[]>("/api/clients")
      .then((rows) => {
        setClients(rows);
        const fromQuery = search.get("clientId");
        const initial =
          rows.find((c) => c.id === fromQuery && c.email) ??
          rows.find((c) => c.email) ??
          null;
        if (fromQuery && !rows.some((c) => c.id === fromQuery && c.email)) {
          setMode("other");
        }
        if (initial) {
          setClientId(initial.id);
          setTo(initial.email ?? "");
        }
        const tpl = (search.get("template") as EmailTemplateId) || "blank";
        const applied = applyTemplate(tpl, {
          clientName: initial?.displayName,
          docNumber: search.get("docNumber") ?? undefined,
        });
        setTemplateId(tpl);
        setSubject(applied.subject);
        setBody(applied.body);
        setReady(true);
      })
      .catch((e: Error) => toast.error(e.message));
  }, [search]);

  function applyClient(id: string) {
    const c = clients.find((x) => x.id === id);
    setClientId(id);
    setTo(c?.email ?? "");
    const applied = applyTemplate(templateId, {
      clientName: c?.displayName,
      docNumber: search.get("docNumber") ?? undefined,
    });
    setSubject(applied.subject);
    setBody(applied.body);
  }

  function onTemplateChange(id: EmailTemplateId) {
    setTemplateId(id);
    const c = clients.find((x) => x.id === clientId);
    const applied = applyTemplate(id, {
      clientName: mode === "client" ? c?.displayName : undefined,
      docNumber: search.get("docNumber") ?? undefined,
    });
    setSubject(applied.subject);
    setBody(applied.body);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ threadId: string }>("/api/emails/send", {
        method: "POST",
        body: JSON.stringify({
          to,
          subject,
          body,
          clientId: mode === "client" && clientId ? clientId : undefined,
        }),
      });
      toast.success("Message envoyé");
      navigate(`/inbox/${res.threadId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const clientsWithEmail = clients.filter((c) => c.email);

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Nouveau message" />
      <Card className="p-5">
        {!ready ? (
          <p className="text-sm text-[var(--muted)]">Chargement…</p>
        ) : (
          <form onSubmit={send} className="space-y-4">
            <Field label="Destinataire">
              <Select
                value={mode}
                onChange={(e) => setMode(e.target.value as "client" | "other")}
              >
                <option value="client">Un de mes clients</option>
                <option value="other">Autre adresse</option>
              </Select>
            </Field>
            {mode === "client" ? (
              <Field label="Client">
                <Select
                  required
                  value={clientId}
                  onChange={(e) => applyClient(e.target.value)}
                >
                  <option value="">Choisir…</option>
                  {clientsWithEmail.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.clientNumber ? `${c.clientNumber} · ` : ""}
                      {c.displayName} ({c.email})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Adresse email">
                <Input
                  type="email"
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            )}
            <Field label="Modèle">
              <Select
                value={templateId}
                onChange={(e) => onTemplateChange(e.target.value as EmailTemplateId)}
              >
                {EMAIL_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
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
              <Button type="submit" disabled={busy || !to}>
                {busy ? "Envoi…" : "Envoyer"}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
