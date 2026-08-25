import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faSearch } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Field";
import {
  ClientFormEditor,
  clientToForm,
  type Client,
} from "@/components/clients/ClientForm";
import { ClientEmailLink } from "@/components/clients/ClientEmailLink";

export function ClientsPage() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Client | null>(null);

  async function load() {
    const rows = await api<Client[]>("/api/clients");
    setClients(rows);
  }

  useEffect(() => {
    load()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return clients;
    return clients.filter(
      (c) =>
        c.displayName.toLowerCase().includes(s) ||
        c.clientNumber?.toLowerCase().includes(s) ||
        c.email?.toLowerCase().includes(s) ||
        c.city?.toLowerCase().includes(s) ||
        c.phone?.includes(s),
    );
  }, [clients, q]);

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Carnet d’adresses  -  particuliers et professionnels"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setModal("create");
            }}
          >
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
            Nouveau client
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-white px-3 py-2 shadow-[var(--shadow)]">
        <FontAwesomeIcon icon={faSearch} className="text-[var(--muted)]" />
        <Input
          className="border-0 shadow-none focus:ring-0"
          placeholder="Rechercher nom, email, ville…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <Card>
        {loading ? (
          <p className="p-8 text-sm text-[var(--muted)]">Chargement…</p>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Aucun client"
            hint="Créez votre premier contact pour facturer et suivre les échanges."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--bg)]/80 text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Code suivi</th>
                  <th className="px-4 py-3 font-medium">Nom</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Contact</th>
                  <th className="px-4 py-3 font-medium">Ville</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-[var(--border)] hover:bg-[var(--bg)]/50">
                    <td className="px-4 py-3 font-mono text-sm font-semibold text-[var(--primary)]">
                      {c.clientNumber ?? " - "}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="font-medium text-[var(--primary)] hover:underline"
                        onClick={() => navigate(`/clients/${c.id}`)}
                      >
                        {c.displayName}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={c.type === "B2B" ? "teal" : "neutral"}>
                        {c.type === "B2B" ? "Pro" : "Particulier"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      <div>{c.email ?? " - "}</div>
                      <div className="text-xs">{c.phone ?? ""}</div>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{c.city ?? " - "}</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        className="h-8 px-2 text-xs"
                        onClick={() => {
                          setEditing(c);
                          setModal("edit");
                        }}
                      >
                        Modifier
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={modal === "create" || modal === "edit"}
        onClose={() => setModal(null)}
        title={modal === "edit" ? "Modifier le client" : "Nouveau client"}
        description="Les emails et téléphones sont chiffrés en base."
        wide
      >
        <ClientFormEditor
          clientId={editing?.id}
          initial={editing ? clientToForm(editing) : undefined}
          onCancel={() => setModal(null)}
          onSuccess={async (client) => {
            setModal(null);
            await load();
            navigate(`/clients/${client.id}`);
          }}
        />
      </Modal>
    </div>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [docs, setDocs] = useState<
    Array<{
      id: string;
      number: string | null;
      status: string;
      documentType: string;
      totalCents: number;
      client: { id: string };
    }>
  >([]);

  useEffect(() => {
    if (!id) return;
    api<Client>(`/api/clients/${id}`)
      .then(setClient)
      .catch((e: Error) => toast.error(e.message));
    Promise.all([
      api<typeof docs>("/api/invoices"),
      api<typeof docs>("/api/invoices?type=QUOTE"),
    ]).then(([invoices, quotes]) => {
      setDocs([...invoices, ...quotes].filter((d) => d.client.id === id));
    });
  }, [id]);

  if (!client) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  return (
    <div className="space-y-6">
      <PageHeader
        title={client.displayName}
        subtitle={`${client.type === "B2B" ? "Professionnel" : "Particulier"} · créé le ${formatDate(client.createdAt)}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate("/clients")}>
              Retour
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void api<{ accessCode: string }>(
                  `/api/clients/${client.id}/regenerate-access-code`,
                  { method: "POST", body: "{}" },
                )
                  .then((r) =>
                    toast.success(`Nouveau code d'accès : ${r.accessCode}`, {
                      duration: 12000,
                    }),
                  )
                  .catch((e: Error) => toast.error(e.message));
              }}
            >
              Régénérer code d&apos;accès
            </Button>
            <Button onClick={() => setEditOpen(true)}>Modifier</Button>
          </>
        }
      />

      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Code de suivi (unique)
            </p>
            <p className="mt-1 font-mono text-xl font-semibold text-[var(--primary)]">
              {client.clientNumber ?? "Non attribué"}
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Identifiant client immuable · utilisé pour le suivi public (/suivi)
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-3 p-5 text-sm lg:col-span-2">
          <h2 className="font-semibold">Coordonnées</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[var(--muted)]">Email</dt>
              <dd>
                <ClientEmailLink email={client.email} name={client.displayName} />
              </dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Téléphone</dt>
              <dd>{client.phone ?? " - "}</dd>
            </div>
            {client.type === "B2B" ? (
              <div>
                <dt className="text-[var(--muted)]">SIRET</dt>
                <dd>{client.siret ?? " - "}</dd>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="text-[var(--muted)]">Adresse</dt>
              <dd>
                {[
                  client.addressLine1,
                  client.addressLine2,
                  [client.postalCode, client.city].filter(Boolean).join(" "),
                  client.country,
                ]
                  .filter(Boolean)
                  .join(", ") || " - "}
              </dd>
            </div>
            {client.notes ? (
              <div className="sm:col-span-2">
                <dt className="text-[var(--muted)]">Notes</dt>
                <dd className="whitespace-pre-wrap">{client.notes}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
        <Card className="space-y-3 p-5 text-sm">
          <h2 className="font-semibold">Documents</h2>
          {docs.length === 0 ? (
            <p className="text-[var(--muted)]">Aucun devis ni facture.</p>
          ) : (
            <ul className="space-y-2">
              {docs.map((d) => (
                <li key={d.id}>
                  <Link
                    to={d.documentType === "QUOTE" ? `/quotes/${d.id}` : `/invoices/${d.id}`}
                    className="flex justify-between gap-2 hover:text-[var(--primary)]"
                  >
                    <span>
                      {d.number ?? "Brouillon"} ·{" "}
                      {d.documentType === "QUOTE" ? "Devis" : "Facture"}
                    </span>
                    <span className="tabular-nums text-[var(--muted)]">
                      {formatEUR(d.totalCents)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Modifier le client" wide>
        <ClientFormEditor
          clientId={client.id}
          initial={clientToForm(client)}
          onCancel={() => setEditOpen(false)}
          onSuccess={(c) => {
            setClient(c);
            setEditOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}
