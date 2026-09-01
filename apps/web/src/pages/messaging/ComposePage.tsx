import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { ClientEmailCombobox } from "@/pages/messaging/ClientEmailCombobox";
import {
  AttachmentChips,
  type AttachmentChipItem,
} from "@/components/messaging/AttachmentChips";
import {
  EMAIL_TEMPLATES,
  applyTemplate,
  type EmailTemplateId,
} from "@/lib/email-templates";

type ClientOpt = {
  id: string;
  displayName: string;
  email?: string | null;
  clientNumber?: string | null;
};

type DocOpt = {
  id: string;
  number: string | null;
  documentType: string;
};

const DRAFT_KEY = "kouzia-compose-draft";

function loadDraft(clientId: string): { attachmentIds: string[]; chips: AttachmentChipItem[] } | null {
  try {
    const raw = localStorage.getItem(`${DRAFT_KEY}:${clientId}`);
    if (!raw) return null;
    return JSON.parse(raw) as { attachmentIds: string[]; chips: AttachmentChipItem[] };
  } catch {
    return null;
  }
}

function saveDraft(clientId: string, attachmentIds: string[], chips: AttachmentChipItem[]) {
  if (!clientId) return;
  localStorage.setItem(
    `${DRAFT_KEY}:${clientId}`,
    JSON.stringify({ attachmentIds, chips: chips.filter((c) => c.kind === "file") }),
  );
}

export function ComposePage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [clients, setClients] = useState<ClientOpt[]>([]);
  const [clientDocs, setClientDocs] = useState<DocOpt[]>([]);
  const [clientId, setClientId] = useState(search.get("clientId") ?? "");
  const [to, setTo] = useState(search.get("to") ?? "");
  const [templateId, setTemplateId] = useState<EmailTemplateId>(
    (search.get("template") as EmailTemplateId) || "blank",
  );
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [documentId, setDocumentId] = useState(search.get("documentId") ?? "");
  const [chips, setChips] = useState<AttachmentChipItem[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api<ClientOpt[]>("/api/clients")
      .then((rows) => {
        setClients(rows);
        const fromQuery = search.get("clientId");
        const initial = fromQuery ? rows.find((c) => c.id === fromQuery && c.email) ?? null : null;
        if (initial) {
          setClientId(initial.id);
          setTo(search.get("to") ?? initial.email ?? "");
          const draft = loadDraft(initial.id);
          if (draft) {
            setAttachmentIds(draft.attachmentIds);
            setChips(draft.chips);
          }
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

  useEffect(() => {
    if (!clientId) {
      setClientDocs([]);
      return;
    }
    void Promise.all([
      api<DocOpt[]>(`/api/invoices?clientId=${clientId}&pageSize=50`),
      api<DocOpt[]>(`/api/invoices?type=QUOTE&clientId=${clientId}&pageSize=50`),
    ])
      .then(([inv, quotes]) => setClientDocs([...inv, ...quotes].filter((d) => d.number)))
      .catch(() => setClientDocs([]));
  }, [clientId]);

  useEffect(() => {
    if (clientId) saveDraft(clientId, attachmentIds, chips);
  }, [clientId, attachmentIds, chips]);

  function applyClient(client: ClientOpt) {
    setClientId(client.id);
    setTo(client.email ?? "");
    const draft = loadDraft(client.id);
    setAttachmentIds(draft?.attachmentIds ?? []);
    setChips(draft?.chips ?? []);
    setDocumentId("");
    const applied = applyTemplate(templateId, {
      clientName: client.displayName,
      docNumber: search.get("docNumber") ?? undefined,
    });
    setSubject(applied.subject);
    setBody(applied.body);
  }

  function onTemplateChange(id: EmailTemplateId) {
    setTemplateId(id);
    const c = clients.find((x) => x.id === clientId);
    const applied = applyTemplate(id, {
      clientName: clientId ? c?.displayName : undefined,
      docNumber: search.get("docNumber") ?? undefined,
    });
    setSubject(applied.subject);
    setBody(applied.body);
  }

  function addDocumentChip(id: string) {
    const doc = clientDocs.find((d) => d.id === id);
    if (!doc?.number) return;
    setDocumentId(id);
    setChips((prev) => [
      ...prev.filter((c) => c.kind !== "document"),
      {
        id: `doc-${id}`,
        filename: `${doc.documentType === "QUOTE" ? "Devis" : "Facture"} ${doc.number}.pdf`,
        sizeBytes: 0,
        kind: "document",
      },
    ]);
  }

  function removeChip(id: string) {
    const chip = chips.find((c) => c.id === id);
    if (!chip) return;
    if (chip.kind === "document") {
      setDocumentId("");
      setChips((prev) => prev.filter((c) => c.id !== id));
      return;
    }
    void api(`/api/emails/draft-attachments/${id}`, { method: "DELETE" }).catch(() => undefined);
    setAttachmentIds((prev) => prev.filter((x) => x !== id));
    setChips((prev) => prev.filter((c) => c.id !== id));
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    for (const file of list) {
      const form = new FormData();
      form.append("file", file);
      try {
        const saved = await api<{ id: string; filename: string; sizeBytes: number }>(
          "/api/emails/draft-attachments",
          { method: "POST", body: form },
        );
        setAttachmentIds((prev) => [...prev, saved.id]);
        setChips((prev) => [
          ...prev,
          {
            id: saved.id,
            filename: saved.filename,
            sizeBytes: saved.sizeBytes,
            kind: "file",
          },
        ]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Upload impossible");
      }
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        to,
        subject,
        body,
        clientId: clientId || undefined,
        documentId: documentId || undefined,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
      };
      const res = await api<{ threadId: string }>("/api/emails/send", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (clientId) localStorage.removeItem(`${DRAFT_KEY}:${clientId}`);
      toast.success(documentId ? "Document en file d'envoi" : "Message en file d'envoi");
      navigate(`/inbox/${res.threadId}`);
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
        {!ready ? (
          <p className="text-sm text-[var(--muted)]">Chargement…</p>
        ) : (
          <form onSubmit={send} className="space-y-4">
            <Field label="À" hint="Recherchez un client (nom, n°, email) ou saisissez une adresse libre.">
              <ClientEmailCombobox
                value={to}
                onChange={(email, client) => {
                  if (client) {
                    applyClient(client);
                    return;
                  }
                  setTo(email);
                  setClientId("");
                }}
              />
            </Field>
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
            {clientDocs.length > 0 ? (
              <Field label="Document ERP (PDF)">
                <Select
                  value={documentId}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) addDocumentChip(id);
                    else {
                      setDocumentId("");
                      setChips((prev) => prev.filter((c) => c.kind !== "document"));
                    }
                  }}
                >
                  <option value="">Aucun document</option>
                  {clientDocs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.documentType === "QUOTE" ? "Devis" : "Facture"} {d.number}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Pièces jointes">
              <AttachmentChips
                items={chips}
                disabled={busy}
                onRemove={removeChip}
                onAddFiles={(files) => void addFiles(files)}
              />
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
