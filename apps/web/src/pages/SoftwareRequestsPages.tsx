import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, formatDate } from "@/lib/api";
import { useUrlFilters } from "@/lib/use-url-filters";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Modal } from "@/components/ui/Modal";
import { FilterSelect } from "@/components/ui/ListFilters";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ClientFormEditor, emptyClientForm } from "@/components/clients/ClientForm";
import { LoadState } from "@/pages/site/shared";
import {
  DURATION_LABEL,
  EDITION_LABEL,
  SEATS_LABEL,
  SOFTWARE_LABEL,
  STATUS_LABEL,
  type RequestStatus,
  type SoftwareRequestDetail,
  type SoftwareRequestItem,
} from "@/lib/software-requests";

type Filter = "all" | RequestStatus;
const SLUG_OF: Record<Filter, string> = { all: "toutes", PENDING: "en-attente", CONVERTED: "converties", DECLINED: "refusees" };
const FILTER_OF: Record<string, Filter> = Object.fromEntries(Object.entries(SLUG_OF).map(([f, s]) => [s, f as Filter]));
const TONE: Record<RequestStatus, "amber" | "green" | "neutral"> = { PENDING: "amber", CONVERTED: "green", DECLINED: "neutral" };

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Erreur inattendue.");

function StatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function SoftwareRequestsPage() {
  const navigate = useNavigate();
  const filters = useUrlFilters();
  const filter = FILTER_OF[filters.pick("statut", Object.values(SLUG_OF), "en-attente")] ?? "PENDING";
  const [rows, setRows] = useState<SoftwareRequestItem[]>([]);
  const [counts, setCounts] = useState<Record<RequestStatus, number>>({ PENDING: 0, CONVERTED: 0, DECLINED: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ items: SoftwareRequestItem[]; counts: Record<RequestStatus, number> }>(
        `/api/software-requests${filter === "all" ? "" : `?status=${filter}`}`,
      );
      setRows(res.items);
      setCounts(res.counts);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const total = counts.PENDING + counts.CONVERTED + counts.DECLINED;
  const columns: DataColumn<SoftwareRequestItem>[] = [
    {
      name: "Entreprise",
      grow: 2,
      cell: (r) => (
        <div className="min-w-0 py-2">
          <Link to={`/demandes-logiciel/${r.id}`} className="block max-w-full truncate font-medium hover:text-[var(--primary)]">
            {r.companyName}
          </Link>
          <p className="truncate text-xs text-[var(--muted)]">{r.contactName}</p>
        </div>
      ),
    },
    { name: "Logiciel", width: "8rem", showFrom: 1024, cell: (r) => SOFTWARE_LABEL[r.software] ?? r.software },
    { name: "Postes", width: "10rem", showFrom: 1280, cell: (r) => SEATS_LABEL[r.seats] ?? r.seats },
    { name: "Reçue le", width: "8rem", showFrom: 1024, cell: (r) => formatDate(r.createdAt) },
    { name: "État", width: "9rem", cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Demandes logiciel"
        subtitle="Demandes d'utilisation de Tracebay envoyées depuis le site. Convertissez une demande en client pour préparer sa clé."
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {counts.PENDING > 0 && filter !== "PENDING" ? (
          <Banner
            level="info"
            className="mb-4"
            action={
              <Link to="?statut=en-attente" replace className="link inline-flex min-h-11 items-center text-sm font-medium">
                Afficher les demandes en attente
              </Link>
            }
          >
            {counts.PENDING > 1 ? `${counts.PENDING} demandes attendent une réponse.` : "1 demande attend une réponse."}
          </Banner>
        ) : null}
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => navigate(`/demandes-logiciel/${r.id}`)}
            countLabel={rows.length > 1 ? "demandes" : "demande"}
            emptyTitle={filter === "PENDING" ? "Aucune demande en attente" : "Aucune demande"}
            emptyHint="Les demandes arrivent ici quand une entreprise remplit le formulaire Tracebay du site."
            toolbar={
              <FilterSelect
                label="État"
                value={filter}
                onChange={(f) => filters.set({ statut: SLUG_OF[f] })}
                options={[
                  { id: "PENDING", label: "En attente", count: counts.PENDING },
                  { id: "CONVERTED", label: "Converties", count: counts.CONVERTED },
                  { id: "DECLINED", label: "Refusées", count: counts.DECLINED },
                  { id: "all", label: "Toutes", count: total },
                ]}
              />
            }
            renderMobileCard={(r) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <Link to={`/demandes-logiciel/${r.id}`} className="block min-h-11 min-w-0 flex-1">
                  <span className="line-clamp-2 break-words font-medium">{r.companyName}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
                    {r.contactName}, {formatDate(r.createdAt)}
                  </span>
                  <span className="mt-1 block">
                    <StatusBadge status={r.status} />
                  </span>
                </Link>
              </div>
            )}
          />
        </Card>
      </LoadState>
    </div>
  );
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function SoftwareRequestPage() {
  const { id = "" } = useParams();
  const [item, setItem] = useState<SoftwareRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [declining, setDeclining] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItem(await api<SoftwareRequestDetail>(`/api/software-requests/${encodeURIComponent(id)}`));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const link = async (clientId: string) => {
    setBusy(true);
    try {
      setItem(await api<SoftwareRequestDetail>(`/api/software-requests/${id}/link`, { method: "POST", body: JSON.stringify({ clientId }) }));
      toast.success("Demande convertie : le client est rattaché.");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      setItem(await api<SoftwareRequestDetail>(`/api/software-requests/${id}/decline`, { method: "POST" }));
      setDeclining(false);
      toast.success("Demande refusée.");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const software = item ? (SOFTWARE_LABEL[item.software] ?? item.software) : "";
  return (
    <div>
      <PageHeader
        title={item ? item.companyName : "Demande"}
        subtitle={item ? `Demande ${software} reçue le ${formatDate(item.createdAt)}` : undefined}
        back={{ to: "/demandes-logiciel", label: "Demandes logiciel" }}
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {item ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
            <Card className="p-5">
              <h2 className="font-display text-base font-semibold">Demande</h2>
              <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">Contact</dt>
                  <dd>{item.contactName}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">E-mail</dt>
                  <dd className="break-all">
                    <a className="link" href={`mailto:${item.email}`}>
                      {item.email}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">Téléphone</dt>
                  <dd>{item.phone ?? "Non renseigné"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">Logiciel</dt>
                  <dd>{software}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">Version souhaitée</dt>
                  <dd>{EDITION_LABEL[item.edition] ?? item.edition}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">Postes ou utilisateurs</dt>
                  <dd>{SEATS_LABEL[item.seats] ?? item.seats}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-[var(--muted)]">Durée souhaitée</dt>
                  <dd>{DURATION_LABEL[item.duration] ?? item.duration}</dd>
                </div>
              </dl>
              <h3 className="mt-5 text-xs font-semibold text-[var(--muted)]">Besoin</h3>
              <p className="mt-1 whitespace-pre-line break-words">{item.need}</p>
              <p className="mt-5 text-xs text-[var(--muted)]">
                Mention d'information affichée au dépôt : version {item.noticeVersion}. Sans suite, la demande est supprimée 3 ans
                après le dernier échange.
              </p>
            </Card>
            <Card className="flex flex-col gap-3 p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-base font-semibold">Suite</h2>
                <StatusBadge status={item.status} />
              </div>
              {item.client ? (
                <p className="text-sm">
                  Client :{" "}
                  <Link className="link" to={`/clients/${item.client.id}`}>
                    {item.client.displayName}
                  </Link>
                  {item.convertedAt ? `, depuis le ${formatDate(item.convertedAt)}` : ""}
                </p>
              ) : null}
              {item.status === "DECLINED" && item.declinedAt ? (
                <p className="text-sm text-[var(--muted)]">Refusée le {formatDate(item.declinedAt)}.</p>
              ) : null}
              {item.status !== "CONVERTED" ? (
                <>
                  {item.suggestedClient ? (
                    <>
                      <p className="text-sm text-[var(--muted)]">
                        Cet e-mail est celui du client {item.suggestedClient.displayName}
                        {item.suggestedClient.clientNumber ? ` (${item.suggestedClient.clientNumber})` : ""}.
                      </p>
                      <Button disabled={busy} onClick={() => void link(item.suggestedClient!.id)}>
                        Rattacher à {item.suggestedClient.displayName}
                      </Button>
                    </>
                  ) : null}
                  <Button variant={item.suggestedClient ? "secondary" : "primary"} disabled={busy} onClick={() => setConverting(true)}>
                    Convertir en client
                  </Button>
                  {item.status === "PENDING" ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setDeclining(true)}>
                      Refuser la demande
                    </Button>
                  ) : null}
                </>
              ) : null}
            </Card>
          </div>
        ) : null}
      </LoadState>

      {item ? (
        <Modal open={converting} onClose={() => setConverting(false)} title="Convertir en client" description="Fiche préremplie avec la demande : complétez-la puis enregistrez." wide>
          <ClientFormEditor
            initial={{ ...emptyClientForm(), type: "B2B", companyName: item.companyName, ...splitName(item.contactName), email: item.email, phone: item.phone ?? "" }}
            onCancel={() => setConverting(false)}
            onSuccess={async (client) => {
              setConverting(false);
              await link(client.id);
            }}
          />
        </Modal>
      ) : null}
      <ConfirmDialog
        open={declining}
        title="Refuser la demande ?"
        message="La demande passe en « Refusée ». Aucun e-mail n'est envoyé : répondez au demandeur vous-même si besoin."
        confirmLabel="Refuser"
        danger
        busy={busy}
        onConfirm={() => void decline()}
        onClose={() => setDeclining(false)}
      />
    </div>
  );
}
