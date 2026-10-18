import { CLIENT_TYPE_LABEL, CLIENT_TYPE_SHORT, CLIENT_TYPE_TONE, isOrganization, type ClientType } from "@/lib/client-type";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faPaperPlane, faEnvelope, faPen } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { useLiveRefresh } from "@/lib/notifications";
import { isNetworkFailure } from "@/lib/network";
import { api, formatEUR } from "@/lib/api";
import { formatDate, formatPhoneFr, invoiceStatusLabel, quoteStatusLabel, statusTone } from "@/lib/format";
import { Button, ButtonLink } from "@/components/ui/Button";
import { StatStrip } from "@/components/ui/StatStrip";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { OfflineGuard } from "@/components/ui/OfflineGuard";
import { ClientNotesCard } from "@/components/clients/ClientNotesCard";
import { isLocalClientId, resolvedClientId, useOfflineQueue } from "@/lib/offline/queue";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input } from "@/components/ui/Field";
import { FilterBar, FilterSegment } from "@/components/ui/ListFilters";
import { useUrlFilters } from "@/lib/use-url-filters";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Avatar } from "@/components/ui/Avatar";
import { ListRow } from "@/components/ui/ListRow";
import {
  ClientFormEditor,
  clientToForm,
  prefillToForm,
  type ClientPrefill,
  type ClientFormData,
  type Client,
  pendingClient,
} from "@/components/clients/ClientForm";
import { ClientEmailLink } from "@/components/clients/ClientEmailLink";
import { ClientProjects } from "@/components/clients/ClientProjects";
import { ClientNeedsCard } from "@/components/clients/ClientNeedsCard";
import { ClientRenewalsCard } from "@/components/clients/ClientRenewalsCard";
import { ClientMessagesTab } from "@/pages/messaging/ClientMessagesTab";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useCreateParam } from "@/lib/use-create-param";


const TYPE_IDS = ["tous", "particulier", "pro", "association"] as const;
const TYPE_OF: Record<Exclude<(typeof TYPE_IDS)[number], "tous">, ClientType> = { particulier: "B2C", pro: "B2B", association: "ASSOCIATION" };

export function ClientsPage() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Client | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  // Filtres dans l'URL : type (particulier, pro, association), échanges (avec, sans) et recherche.
  const filters = useUrlFilters();
  const typeFilter = filters.pick("type", TYPE_IDS, "tous");
  const correspondenceFilter = filters.pick("echanges", ["tous", "avec", "sans"] as const, "tous");
  // Création depuis un message du formulaire du site : fiche préremplie (état de navigation, pas l'URL).
  const location = useLocation();
  const [createInitial, setCreateInitial] = useState<ClientFormData | undefined>(undefined);
  const openCreate = useCallback(() => {
    const prefill = (location.state as { prefill?: ClientPrefill } | null)?.prefill;
    setCreateInitial(prefill ? prefillToForm(prefill) : undefined);
    setEditing(null);
    setModal("create");
  }, [location.state]);

  useCreateParam(openCreate);

  async function load() {
    const params = new URLSearchParams();
    if (correspondenceFilter === "avec") params.set("hasCorrespondence", "true");
    if (correspondenceFilter === "sans") params.set("hasCorrespondence", "false");
    const qs = params.toString();
    const rows = await api<Client[]>(`/api/clients${qs ? `?${qs}` : ""}`);
    setClients(rows);
  }

  // Chargement de la liste : état d'erreur avec « Réessayer » (dans le tableau), pas un simple toast.
  function fetchList() {
    setLoading(true);
    setLoadError(null);
    load()
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchList();
  }, [correspondenceFilter]);

  const { items: queued } = useOfflineQueue();
  const allRows = useMemo(
    () => [...queued.filter((i) => i.kind === "client").map(pendingClient), ...clients],
    [queued, clients],
  );
  // Type filtré sur place : il marche aussi sur la copie hors ligne de la liste.
  const rows = typeFilter === "tous" ? allRows : allRows.filter((c) => c.type === TYPE_OF[typeFilter]);
  const filtering = typeFilter !== "tous" || correspondenceFilter !== "tous" || filters.text("q").trim() !== "";

  const columns: DataColumn<Client>[] = [
    {
      name: "Client",
      selector: (c) => c.displayName,
      sortable: true,
      grow: 3,
      cell: (c) => (
        <div className="flex min-w-0 items-center gap-3 py-1">
          <Avatar name={c.displayName} size="sm" />
          <div className="min-w-0">
            <Link to={`/clients/${c.id}`} className="line-clamp-2 break-words font-medium hover:text-[var(--primary)]">
              {c.displayName}
            </Link>
            {isLocalClientId(c.id) ? (
              <Badge tone="amber">À envoyer</Badge>
            ) : (
              <p className="font-mono text-xs text-[var(--muted)]">{c.clientNumber ?? "-"}</p>
            )}
          </div>
        </div>
      ),
    },
    {
      name: "Type",
      selector: (c) => c.type,
      sortable: true,
      width: "8rem",
      cell: (c) => (
        <Badge tone={CLIENT_TYPE_TONE[c.type]}>{CLIENT_TYPE_LABEL[c.type]}</Badge>
      ),
    },
    {
      name: "Contact",
      grow: 2,
      cell: (c) => (
        <div className="min-w-0 text-[var(--muted)]">
          <div className="line-clamp-2 break-all text-[var(--text)]" title={c.email ?? undefined}>
            {c.email ?? "-"}
          </div>
          {c.phone ? <div className="text-xs">{formatPhoneFr(c.phone)}</div> : null}
        </div>
      ),
    },
    {
      name: "Ville",
      selector: (c) => c.city ?? "",
      sortable: true,
      width: "9rem",
      showFrom: 1280,
      cell: (c) => <span className="py-1 whitespace-normal break-words text-[var(--muted)]">{c.city ?? "-"}</span>,
    },
    {
      name: "Dernier échange",
      width: "9.5rem",
      showFrom: 1280,
      cell: (c) =>
        c.lastExchange ? (
          <Link
            to={`/clients/${c.id}?tab=messages`}
            className="block min-w-0 text-left text-sm hover:underline"
            title={c.lastExchange.subject}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[var(--text)]">{formatDate(c.lastExchange.lastMessageAt)}</span>
            <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">{c.lastExchange.subject}</span>
          </Link>
        ) : (
          <span className="text-sm text-[var(--muted)]">Aucun</span>
        ),
    },
    {
      name: "",
      grow: 0,
      width: "6.5rem",
      right: true,
      ignoreRowClick: true,
      button: true,
      cell: (c) => (
        <div className="flex justify-end gap-1">
          {c.email ? (
            <Button
              variant="ghost"
              className="min-h-9 min-w-9 px-0"
              aria-label={`Écrire à ${c.displayName}`}
              title="Écrire"
              onClick={() =>
                navigate(`/inbox/compose?clientId=${encodeURIComponent(c.id)}&to=${encodeURIComponent(c.email ?? "")}`)
              }
            >
              <FontAwesomeIcon icon={faEnvelope} className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            className="min-h-9 min-w-9 px-0"
            disabled={isLocalClientId(c.id)}
            aria-label={`Modifier ${c.displayName}`}
            title="Modifier"
            onClick={() => {
              setEditing(c);
              setModal("edit");
            }}
          >
            <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Particuliers, professionnels et associations : coordonnées et historique des échanges."
        actions={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(true)}>
              <FontAwesomeIcon icon={faPaperPlane} className="h-3.5 w-3.5" aria-hidden />
              Inviter par email
            </Button>
          </>
        }
        offlineActions={
          <Button onClick={openCreate}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouveau client
          </Button>
        }
      />

      <DataTable
          columns={columns}
          data={rows}
          loading={loading}
          error={loadError}
          onRetry={fetchList}
          pagination
          perPage={25}
          onRowClick={(c) => navigate(`/clients/${c.id}`)}
          countLabel={rows.length > 1 ? "clients" : "client"}
          toolbar={
            <FilterBar>
              <FilterSegment
                label="Type"
                compact
                value={typeFilter}
                onChange={(v) => filters.set({ type: v === "tous" ? null : v })}
                wrap
                options={[
                  { id: "tous", label: "Tous" },
                  { id: "particulier", label: "Particuliers" },
                  { id: "pro", label: "Pros" },
                  { id: "association", label: "Associations" },
                ]}
              />
              <FilterSegment
                label="Échanges"
                value={correspondenceFilter}
                onChange={(v) => filters.set({ echanges: v === "tous" ? null : v })}
                options={[
                  { id: "tous", label: "Tous" },
                  { id: "avec", label: "Avec" },
                  { id: "sans", label: "Sans" },
                ]}
              />
            </FilterBar>
          }
          renderMobileCard={(c) => (
            <ListRow
              to={`/clients/${c.id}`}
              leading={<Avatar name={c.displayName} />}
              title={c.displayName}
              meta={[c.clientNumber, c.city].filter(Boolean).join(" · ")}
              badges={isLocalClientId(c.id) ? <Badge tone="amber">À envoyer</Badge> : <Badge tone={CLIENT_TYPE_TONE[c.type]}>{CLIENT_TYPE_SHORT[c.type]}</Badge>}
            />
          )}
          searchable={["displayName", "clientNumber", "email", "city", "phone"]}
          searchPlaceholder="Rechercher un nom, un email, une ville"
          searchLabel="Rechercher"
          search={filters.text("q")}
          onSearchChange={(q) => filters.set({ q })}
          emptyTitle={filtering ? "Aucun client ne correspond" : "Aucun client"}
          emptyHint={filtering ? "Changez la recherche ou les filtres." : "Créez votre premier client avec le bouton Nouveau client."}
        />

      <Modal
        open={modal === "create" || modal === "edit"}
        onClose={() => setModal(null)}
        title={modal === "edit" ? "Modifier le client" : "Nouveau client"}
        description="Les emails et téléphones sont chiffrés en base."
        wide
        fullScreenMobile
      >
        <ClientFormEditor
          clientId={editing?.id}
          initial={editing ? clientToForm(editing) : createInitial}
          onCancel={() => setModal(null)}
          onSuccess={async (client) => {
            setModal(null);
            // Fiche mise en file hors ligne : la liste du serveur ne change pas.
            if (!isLocalClientId(client.id)) await load();
            navigate(`/clients/${client.id}`);
          }}
        />
      </Modal>

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Inviter un nouveau client par email"
        description="Le prospect recevra un lien sécurisé pour remplir lui-même sa fiche. Le client sera créé automatiquement à la soumission."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!inviteEmail.trim()) return;
            setInviteBusy(true);
            try {
              const r = await api<{ ok: boolean; sent: boolean; reason?: string }>(
                "/api/onboarding/invite",
                { method: "POST", body: JSON.stringify({ email: inviteEmail.trim() }) },
              );
              if (r.sent) {
                toast.success(
                  "Invitation envoyée. Le prospect recevra un lien pour compléter sa fiche.",
                );
              } else if (r.reason === "smtp_off") {
                toast.error("SMTP non configuré : email non envoyé. Configurez SMTP dans .env.");
              } else {
                toast.success("Invitation créée (email non envoyé).");
              }
              setInviteEmail("");
              setInviteOpen(false);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Erreur");
            } finally {
              setInviteBusy(false);
            }
          }}
          className="space-y-4"
        >
          <Field label="Email du prospect" hint="L'invitation sera envoyée à cette adresse">
            <Input
              type="email"
              required
              placeholder="prospect@exemple.fr"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </Field>
          <ModalActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setInviteOpen(false)}
              disabled={inviteBusy}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={inviteBusy}>
              {inviteBusy ? "Envoi..." : "Envoyer l'invitation"}
            </Button>
          </ModalActions>
        </form>
      </Modal>
    </div>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  // Fiche préparée hors ligne, pas encore créée sur le serveur.
  if (isLocalClientId(id)) return <PendingClientPage localId={id} />;
  return <ClientDetail id={id} />;
}

function PendingClientPage({ localId }: { localId: string }) {
  const { ready, items } = useOfflineQueue();
  const item = items.find((i) => i.kind === "client" && i.clientId === localId);
  const real = resolvedClientId(localId);
  if (real) return <Navigate to={`/clients/${real}`} replace />;
  if (!ready) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="ui-card h-24 animate-pulse" />
      </div>
    );
  }
  if (!item) {
    return (
      <div>
        <PageHeader back={{ to: "/clients", label: "Clients" }} title="Fiche introuvable" />
        <Card>
          <EmptyState
            title="Cette fiche préparée hors ligne n'est plus dans la file"
            hint="Elle a peut-être déjà été envoyée : retrouvez-la dans la liste des clients."
            action={<ButtonLink to="/clients">Voir les clients</ButtonLink>}
          />
        </Card>
      </div>
    );
  }
  const client = pendingClient(item);
  return (
    <div>
      <PageHeader
        back={{ to: "/clients", label: "Clients" }}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={client.displayName} size="lg" />
            <span className="min-w-0 truncate">{client.displayName}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="amber">À envoyer</Badge>
            <Badge tone={CLIENT_TYPE_TONE[client.type]}>{CLIENT_TYPE_LABEL[client.type]}</Badge>
            <span className="text-xs">Préparée hors ligne le {formatDate(item.preparedAt)}</span>
          </span>
        }
        offlineActions={
          <ButtonLink to={`/quotes?new=1&clientId=${encodeURIComponent(localId)}`}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouveau devis
          </ButtonLink>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card className="p-5 text-sm">
            <p>
              Fiche préparée hors ligne : elle sera créée au retour du réseau (numéro de client attribué à ce moment),
              puis devis et notes préparés pour elle. Adresse et SIRET se complètent ensuite depuis la fiche.
            </p>
            <Link to="/a-envoyer" className="link mt-2 inline-flex min-h-11 items-center">
              Voir « À envoyer »
            </Link>
          </Card>
          <ClientNotesCard clientId={localId} clientName={client.displayName} />
        </div>
        <aside className="space-y-6" aria-label="Informations du client">
          <Card className="p-5 text-sm">
            <h2 className="mb-3 text-sm font-semibold">Coordonnées</h2>
            <dl className="space-y-3 [&_dt]:text-xs [&_dt]:text-[var(--muted)] [&_dd]:mt-0.5 [&_dd]:break-words">
              <div>
                <dt>Email</dt>
                <dd>{client.email ?? " - "}</dd>
              </div>
              <div>
                <dt>Téléphone</dt>
                <dd>{formatPhoneFr(client.phone) || " - "}</dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function ClientDetail({ id }: { id: string | undefined }) {
  const [client, setClient] = useState<Client | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [busyAccess, setBusyAccess] = useState(false);
  const [busyWelcome, setBusyWelcome] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [busyOnboarding, setBusyOnboarding] = useState(false);
  const [docs, setDocs] = useState<
    Array<{
      id: string;
      number: string | null;
      status: string;
      quoteStatus?: string | null;
      documentType: string;
      totalCents: number;
      client: { id: string };
    }>
  >([]);

  const [docsOffline, setDocsOffline] = useState(false);
  useLiveRefresh(() => refresh(), (i) => i.kind === "quote_accepted" || i.kind === "quote_rejected" || i.kind === "payment");

  function refresh() {
    if (!id) return;
    api<Client>(`/api/clients/${id}`)
      .then(setClient)
      .catch((e: Error) => toast.error(e.message));
  }

  useEffect(() => {
    if (!id) return;
    refresh();
    Promise.all([
      api<typeof docs>(`/api/invoices?clientId=${id}`),
      api<typeof docs>(`/api/invoices?type=QUOTE&clientId=${id}`),
    ])
      .then(([invoices, quotes]) => {
        setDocs([...invoices, ...quotes].filter((d) => d.client.id === id));
        setDocsOffline(false);
      })
      .catch((e: Error) => {
        // Hors ligne sans copie des documents : montants « consultables avec le réseau », jamais 0,00 €.
        if (isNetworkFailure(e)) setDocsOffline(true);
        else toast.error(`Documents du client non chargés : ${e.message}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const [tab, setTab] = useTabParam(["apercu", "documents", "projets", "messages"] as const, "apercu");

  if (!client) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="ui-card h-24 animate-pulse" />
        <div className="ui-card h-64 animate-pulse" />
      </div>
    );
  }

  const invoices = docs.filter((d) => d.documentType !== "QUOTE");
  const quotes = docs.filter((d) => d.documentType === "QUOTE");
  const sumBy = (rows: typeof docs, statuses: string[]) =>
    rows.filter((d) => statuses.includes(d.status)).reduce((acc, d) => acc + d.totalCents, 0);
  const docPath = (d: (typeof docs)[number]) => (d.documentType === "QUOTE" ? `/quotes/${d.id}` : `/invoices/${d.id}`);

  const docList = (rows: typeof docs, limit?: number) =>
    rows.length === 0 ? (
      <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">
        {docsOffline ? "Documents consultables avec le réseau." : "Aucun document pour ce client."}
      </p>
    ) : (
      <ul className="divide-y divide-[var(--border)]">
        {rows.slice(0, limit ?? rows.length).map((d) => (
          <li key={d.id}>
            {/* Sous 640 px : numéro et montant, puis type et statut (le montant restait coupé à 320 px). */}
            <Link
              to={docPath(d)}
              className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm hover:bg-[var(--surface-raised)] sm:flex sm:gap-3"
            >
              <span className="min-w-0 truncate font-mono text-xs text-[var(--primary)] sm:w-28 sm:shrink-0">
                {d.number ?? "Brouillon"}
              </span>
              <span className="text-right font-medium tabular-nums sm:order-last sm:w-24 sm:shrink-0">
                {formatEUR(d.totalCents)}
              </span>
              <span className="min-w-0 truncate text-[var(--muted)] sm:flex-1">
                {d.documentType === "QUOTE" ? "Devis" : "Facture"}
              </span>
              <span className="justify-self-end">
                {(() => {
                  const st = d.documentType === "QUOTE" ? d.quoteStatus ?? d.status : d.status;
                  const lbl = d.documentType === "QUOTE" ? quoteStatusLabel[st] : invoiceStatusLabel[st];
                  return <Badge tone={statusTone(st)}>{lbl ?? st}</Badge>;
                })()}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );

  return (
    <div>
      <PageHeader
        back={{ to: "/clients", label: "Clients" }}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={client.displayName} size="lg" />
            <span className="min-w-0 truncate">{client.displayName}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={CLIENT_TYPE_TONE[client.type]}>
              {CLIENT_TYPE_LABEL[client.type]}
            </Badge>
            {client.clientNumber ? (
              <span className="font-mono text-xs text-[var(--primary)]">{client.clientNumber}</span>
            ) : null}
            <span className="text-xs">Client depuis le {formatDate(client.createdAt)}</span>
          </span>
        }
        actions={
          <>
            {client.email ? (
              <ButtonLink
                variant="secondary"
                to={`/inbox/compose?clientId=${encodeURIComponent(client.id)}&to=${encodeURIComponent(client.email)}`}
              >
                <FontAwesomeIcon icon={faEnvelope} className="h-3.5 w-3.5" aria-hidden />
                Écrire
              </ButtonLink>
            ) : null}
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              <FontAwesomeIcon icon={faPen} className="h-3.5 w-3.5" aria-hidden />
              Modifier
            </Button>
          </>
        }
        offlineActions={
          <ButtonLink to={`/quotes?new=1&clientId=${encodeURIComponent(client.id)}`}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouveau devis
          </ButtonLink>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <Tabs
            label="Sections de la fiche client"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "apercu", label: "Aperçu" },
              { id: "documents", label: "Documents", count: docs.length },
              { id: "projets", label: "Projets" },
              { id: "messages", label: "Messages" },
            ]}
          >
            {tab === "apercu" ? (
              <div className="space-y-6">
                <StatStrip
                  items={docsOffline ? [
                    { label: "Facturé", value: "-", hint: "Consultable avec le réseau" },
                    { label: "Encaissé", value: "-", hint: "Consultable avec le réseau" },
                    { label: "À encaisser", value: "-" },
                    { label: "Devis", value: "-" },
                  ] : [
                    { label: "Facturé", value: formatEUR(sumBy(invoices, ["ISSUED", "PAID"])), hint: `${invoices.length} facture${invoices.length > 1 ? "s" : ""}` },
                    { label: "Encaissé", value: formatEUR(sumBy(invoices, ["PAID"])), tone: "success" },
                    { label: "À encaisser", value: formatEUR(sumBy(invoices, ["ISSUED"])), tone: "primary" },
                    { label: "Devis", value: String(quotes.length), hint: quotes.length ? formatEUR(quotes.reduce((a, d) => a + d.totalCents, 0)) : "aucun" },
                  ]}
                />
                <Card className="overflow-hidden">
                  <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--border)] px-5">
                    <h2 className="text-sm font-semibold">Derniers documents</h2>
                    {docs.length > 5 ? (
                      <button type="button" className="link min-h-11 text-sm" onClick={() => setTab("documents")}>
                        Tout voir
                      </button>
                    ) : null}
                  </div>
                  {docList(docs, 5)}
                </Card>
                <ClientNotesCard clientId={client.id} clientName={client.displayName} />
                <OfflineGuard className="space-y-6">
                  <ClientNeedsCard key={client.id} clientId={client.id} initial={client.needs ?? []} />
                  <ClientRenewalsCard clientId={client.id} />
                </OfflineGuard>
                {client.notes ? (
                  <Card className="p-5">
                    <h2 className="mb-2 text-sm font-semibold">Notes internes</h2>
                    <p className="whitespace-pre-wrap text-sm text-[var(--muted)]">{client.notes}</p>
                  </Card>
                ) : null}
              </div>
            ) : null}
            {tab === "documents" ? <Card className="overflow-hidden">{docList(docs)}</Card> : null}
            {tab === "projets" ? (
              <OfflineGuard>
                <ClientProjects clientId={client.id} />
              </OfflineGuard>
            ) : null}
            {tab === "messages" ? <ClientMessagesTab clientId={client.id} /> : null}
          </Tabs>
        </div>

        <aside className="space-y-6" aria-label="Informations du client">
          <Card className="p-5 text-sm">
            <h2 className="mb-3 text-sm font-semibold">Coordonnées</h2>
            <dl className="space-y-3 [&_dt]:text-xs [&_dt]:text-[var(--muted)] [&_dd]:mt-0.5 [&_dd]:break-words">
            <div>
              <dt className="text-[var(--muted)]">Email</dt>
              <dd>
                <ClientEmailLink
                  email={client.email}
                  name={client.displayName}
                  clientId={client.id}
                />
              </dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Téléphone</dt>
              <dd>{formatPhoneFr(client.phone) || " - "}</dd>
            </div>
            {isOrganization(client.type) ? (
              <div>
                <dt className="text-[var(--muted)]">SIRET</dt>
                <dd>{client.siret ?? " - "}</dd>
              </div>
            ) : null}
            <div>
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
            <div>
              <dt className="text-[var(--muted)]">Prélèvement des abonnements</dt>
              <dd>{client.billingDay ? `Le ${client.billingDay} du mois` : "Le 1er du mois (par défaut)"}</dd>
            </div>
          </dl>
          </Card>
          <OfflineGuard>
          <Card className="space-y-4 p-5 text-sm">
            <h2 className="text-sm font-semibold">Espace client</h2>
        <div>
          <p className="text-xs font-medium text-[var(--muted)]">
            Code de suivi (identifiant public)
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="font-mono text-xl font-semibold text-[var(--primary)]">
              {client.clientNumber ?? "Non attribué"}
            </p>
            {client.clientNumber ? (
              <Button
                type="button"
                variant="ghost"
                className="px-2 text-xs"
                onClick={() => {
                  void navigator.clipboard.writeText(client.clientNumber!);
                  toast.success("Code de suivi copié");
                }}
              >
                Copier
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Identifiant client immuable, repris sur les documents.
          </p>
        </div>

        <div className="border-t border-[var(--border)] pt-3">
          <p className="text-xs font-medium text-[var(--muted)]">Espace client</p>
          <p className="mt-1 text-sm">
            {client.emailVerifiedAt ? (
              <Badge tone="green">E-mail vérifié le {formatDate(client.emailVerifiedAt)}</Badge>
            ) : (
              <Badge tone="neutral">Jamais connecté</Badge>
            )}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Connexion avec l&apos;adresse e-mail de la fiche et un code à 6 chiffres reçu par
            e-mail ; chaque appareil reste reconnu 15 jours.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
          <Button
            variant="secondary"
            disabled={busyWelcome || !client.email}
            title={client.email ? undefined : "Adresse e-mail manquante sur la fiche"}
            onClick={() => {
              setBusyWelcome(true);
              void api<{ sent: boolean; reason?: string }>(`/api/clients/${client.id}/portal/welcome`, {
                method: "POST",
              })
                .then((r) => {
                  if (r.sent) toast.success(`Accès à l'espace client envoyé à ${client.email}.`);
                  else if (r.reason === "smtp_off") toast.error("SMTP non configuré : e-mail non envoyé.");
                  else if (r.reason === "no_email") toast.error("Le client n'a pas d'adresse e-mail.");
                  else toast.error("L'e-mail d'accès n'a pas pu partir.");
                })
                .catch((e: Error) => toast.error(e.message))
                .finally(() => setBusyWelcome(false));
            }}
          >
            {busyWelcome ? "Envoi…" : "Envoyer l'accès à l'espace client"}
          </Button>
          <Button
            variant="secondary"
            disabled={busyAccess}
            onClick={() => setConfirmRegen(true)}
          >
            {busyAccess ? "Déconnexion…" : "Déconnecter tous ses appareils"}
          </Button>
          <ConfirmDialog
            open={confirmRegen}
            title="Déconnecter tous ses appareils ?"
            message="Le client devra se reconnecter avec un nouveau code reçu par e-mail. À utiliser en cas d'appareil perdu ou de connexion suspecte."
            confirmLabel="Déconnecter"
            danger
            busy={busyAccess}
            onClose={() => setConfirmRegen(false)}
            onConfirm={() => {
              setBusyAccess(true);
              void api<{ revoked: number }>(`/api/clients/${client.id}/portal/revoke-sessions`, {
                method: "POST",
                body: "{}",
              })
                .then((r) => {
                  setConfirmRegen(false);
                  toast.success(
                    r.revoked > 0
                      ? `${r.revoked} appareil(s) déconnecté(s).`
                      : "Aucun appareil connecté.",
                  );
                })
                .catch((e: Error) => toast.error(e.message))
                .finally(() => setBusyAccess(false));
            }}
          />

          <Button
            variant="secondary"
            disabled={busyOnboarding || !client.email}
            onClick={() => {
              setBusyOnboarding(true);
              void api<{ ok: boolean; sent: boolean; reason?: string }>(
                `/api/clients/${client.id}/onboarding/invite`,
                { method: "POST", body: JSON.stringify({ email: client.email ?? "" }) },
              )
                .then((r) => {
                  if (r.sent) {
                    toast.success("Invitation envoyée : le client recevra un lien pour compléter sa fiche.");
                  } else if (r.reason === "smtp_off") {
                    toast.error("SMTP non configuré : impossible d'envoyer l'email d'invitation.");
                  } else if (r.reason === "no_email") {
                    toast.error("Le client n'a pas d'email renseigné.");
                  } else {
                    toast.success("Lien d'invitation généré (email non envoyé).");
                  }
                  refresh();
                })
                .catch((e: Error) => toast.error(e.message))
                .finally(() => setBusyOnboarding(false));
            }}
          >
            {busyOnboarding ? "Envoi..." : "Demander les infos par email"}
          </Button>
        </div>

        {client.onboardingCompletedAt ? (
          <p className="border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
            Fiche complétée par le client le {formatDate(client.onboardingCompletedAt)}.
          </p>
        ) : null}
        {!client.email ? (
          <p className="border-t border-[var(--border)] pt-3 text-xs text-[var(--danger)]">
            Aucun email renseigné : impossible d&apos;envoyer le code ou l&apos;invitation.
          </p>
        ) : null}
      </Card>
          </OfflineGuard>
        </aside>
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
