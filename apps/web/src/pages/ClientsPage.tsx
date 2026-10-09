import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faPaperPlane, faEnvelope, faPen } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate, formatPhoneFr, invoiceStatusLabel, quoteStatusLabel, statusTone } from "@/lib/format";
import { Button, ButtonLink } from "@/components/ui/Button";
import { StatStrip } from "@/components/ui/StatStrip";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input } from "@/components/ui/Field";
import { FilterChips } from "@/components/ui/FilterChips";
import { DataTable, type TableColumn } from "@/components/ui/DataTable";
import { Media } from "react-data-table-component";
import { Avatar } from "@/components/ui/Avatar";
import {
  ClientFormEditor,
  clientToForm,
  type Client,
} from "@/components/clients/ClientForm";
import { ClientEmailLink } from "@/components/clients/ClientEmailLink";
import { ClientProjects } from "@/components/clients/ClientProjects";
import { ClientMessagesTab } from "@/pages/messaging/ClientMessagesTab";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useCreateParam } from "@/lib/use-create-param";

export function ClientsPage() {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<Client | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [correspondenceFilter, setCorrespondenceFilter] = useState<"all" | "with" | "without">("all");
  const openCreate = useCallback(() => {
    setEditing(null);
    setModal("create");
  }, []);

  useCreateParam(openCreate);

  async function load() {
    const params = new URLSearchParams();
    if (correspondenceFilter === "with") params.set("hasCorrespondence", "true");
    if (correspondenceFilter === "without") params.set("hasCorrespondence", "false");
    const qs = params.toString();
    const rows = await api<Client[]>(`/api/clients${qs ? `?${qs}` : ""}`);
    setClients(rows);
  }

  useEffect(() => {
    setLoading(true);
    load()
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [correspondenceFilter]);

  const columns: TableColumn<Client>[] = [
    {
      name: "Client",
      selector: (c) => c.displayName,
      sortable: true,
      grow: 3,
      cell: (c) => (
        <div className="flex min-w-0 items-center gap-3 py-1">
          <Avatar name={c.displayName} size="sm" />
          <div className="min-w-0">
            <Link to={`/clients/${c.id}`} className="block truncate font-medium hover:text-[var(--primary)]">
              {c.displayName}
            </Link>
            <p className="font-mono text-xs text-[var(--muted)]">{c.clientNumber ?? "-"}</p>
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
        <Badge tone={c.type === "B2B" ? "violet" : "neutral"}>{c.type === "B2B" ? "Professionnel" : "Particulier"}</Badge>
      ),
    },
    {
      name: "Contact",
      grow: 2,
      cell: (c) => (
        <div className="min-w-0 text-[var(--muted)]">
          <div className="truncate text-[var(--text)]">{c.email ?? "-"}</div>
          {c.phone ? <div className="text-xs">{formatPhoneFr(c.phone)}</div> : null}
        </div>
      ),
    },
    {
      name: "Ville",
      selector: (c) => c.city ?? "",
      sortable: true,
      width: "9rem",
      hide: Media.MD,
      cell: (c) => <span className="truncate text-[var(--muted)]">{c.city ?? "-"}</span>,
    },
    {
      name: "Dernier échange",
      width: "9.5rem",
      hide: Media.LG,
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
        subtitle="Particuliers et professionnels, coordonnées et historique des échanges."
        actions={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(true)}>
              <FontAwesomeIcon icon={faPaperPlane} className="h-3.5 w-3.5" aria-hidden />
              Inviter par email
            </Button>
            <Button onClick={openCreate}>
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
              Nouveau client
            </Button>
          </>
        }
      />

      {loading && clients.length === 0 ? (
        <div className="ui-card h-64 animate-pulse" aria-busy="true" />
      ) : (
        <DataTable
          columns={columns}
          data={clients}
          pagination
          perPage={25}
          onRowClick={(c) => navigate(`/clients/${c.id}`)}
          countLabel={clients.length > 1 ? "clients" : "client"}
          toolbar={
            <FilterChips
              label="Filtrer les clients"
              value={correspondenceFilter}
              onChange={setCorrespondenceFilter}
              options={[
                { id: "all", label: "Tous" },
                { id: "with", label: "Avec échanges" },
                { id: "without", label: "Sans échange" },
              ]}
            />
          }
          renderMobileCard={(c) => (
            <Link
              to={`/clients/${c.id}`}
              className="flex min-w-0 items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 hover:bg-[var(--surface-raised)]"
            >
              <Avatar name={c.displayName} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.displayName}</p>
                <p className="truncate text-xs text-[var(--muted)]">
                  {[c.clientNumber, c.city].filter(Boolean).join(" · ")}
                </p>
              </div>
              <Badge tone={c.type === "B2B" ? "violet" : "neutral"}>{c.type === "B2B" ? "Pro" : "Particulier"}</Badge>
            </Link>
          )}
          searchable={["displayName", "clientNumber", "email", "city", "phone"]}
          searchPlaceholder="Rechercher un nom, un email, une ville"
          emptyTitle="Aucun client"
          emptyHint="Créez votre premier client avec le bouton Nouveau client."
        />
      )}

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
  const [client, setClient] = useState<Client | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [busyAccess, setBusyAccess] = useState(false);
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
      api<typeof docs>(`/api/invoices?clientId=${id}&pageSize=100`),
      api<typeof docs>(`/api/invoices?type=QUOTE&clientId=${id}&pageSize=100`),
    ]).then(([invoices, quotes]) => {
      setDocs([...invoices, ...quotes].filter((d) => d.client.id === id));
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
      <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">Aucun document pour ce client.</p>
    ) : (
      <ul className="divide-y divide-[var(--border)]">
        {rows.slice(0, limit ?? rows.length).map((d) => (
          <li key={d.id}>
            <Link to={docPath(d)} className="flex min-h-12 items-center gap-3 px-5 py-2.5 text-sm hover:bg-[var(--surface-raised)]">
              <span className="w-28 shrink-0 font-mono text-xs text-[var(--primary)]">{d.number ?? "Brouillon"}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--muted)]">
                {d.documentType === "QUOTE" ? "Devis" : "Facture"}
              </span>
              {(() => {
                const st = d.documentType === "QUOTE" ? d.quoteStatus ?? d.status : d.status;
                const lbl = d.documentType === "QUOTE" ? quoteStatusLabel[st] : invoiceStatusLabel[st];
                return <Badge tone={statusTone(st)}>{lbl ?? st}</Badge>;
              })()}
              <span className="w-24 shrink-0 text-right font-medium tabular-nums">{formatEUR(d.totalCents)}</span>
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
            <Badge tone={client.type === "B2B" ? "violet" : "neutral"}>
              {client.type === "B2B" ? "Professionnel" : "Particulier"}
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
            <ButtonLink to="/quotes?new=1">
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
              Nouveau devis
            </ButtonLink>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
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
                  items={[
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
                {client.notes ? (
                  <Card className="p-5">
                    <h2 className="mb-2 text-sm font-semibold">Notes internes</h2>
                    <p className="whitespace-pre-wrap text-sm text-[var(--muted)]">{client.notes}</p>
                  </Card>
                ) : null}
              </div>
            ) : null}
            {tab === "documents" ? <Card className="overflow-hidden">{docList(docs)}</Card> : null}
            {tab === "projets" ? <ClientProjects clientId={client.id} /> : null}
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
            {client.type === "B2B" ? (
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
          </dl>
          </Card>
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
                className="h-8 px-2 text-xs"
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
            Identifiant client immuable, utilisé pour le suivi public (kouzia.com/suivi).
          </p>
        </div>

        <div className="border-t border-[var(--border)] pt-3">
          <p className="text-xs font-medium text-[var(--muted)]">
            Code d&apos;accès secret
          </p>
          <p className="mt-1 text-sm">
            {client.accessCode ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="rounded bg-[var(--bg)] px-2 py-1 font-mono text-base font-semibold tracking-wide text-[var(--text)]">
                  {client.accessCode}
                </span>
                <Badge tone="green">Défini</Badge>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 px-2 text-xs"
                  onClick={() => {
                    void navigator.clipboard.writeText(client.accessCode!);
                    toast.success("Code copié");
                  }}
                >
                  Copier
                </Button>
              </span>
            ) : client.hasAccessCode ? (
              <span className="inline-flex items-center gap-2">
                <span className="font-mono">••••••••</span>
                <Badge tone="amber">Ancien format</Badge>
              </span>
            ) : (
              <Badge tone="neutral">Non défini</Badge>
            )}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {client.accessCode
              ? "Code visible ici et dans l'email envoyé au client. Régénérer invalide l'ancien code."
              : client.hasAccessCode
                ? "Code créé avant la sauvegarde chiffrée : régénérez-le pour l'afficher ici et renvoyer l'email."
                : "Générez le code pour l'envoyer par email et l'afficher sur cette fiche."}
          </p>
          {client.accessEmailSentAt ? (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Dernier envoi par email : {formatDate(client.accessEmailSentAt)}
            </p>
          ) : client.hasAccessCode ? (
            <p className="mt-1 text-xs text-[var(--warning)]">
              Code défini mais aucun email d&apos;identifiants enregistré. Utilisez Régénérer et
              envoyer.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
          <Button
            variant="secondary"
            disabled={busyAccess || !client.email}
            onClick={() => setConfirmRegen(true)}
          >
            {busyAccess
              ? "Envoi…"
              : client.hasAccessCode
                ? "Régénérer et envoyer"
                : "Générer et envoyer"}
          </Button>
          <ConfirmDialog
            open={confirmRegen}
            title={
              client.hasAccessCode
                ? "Régénérer le code d'accès ?"
                : "Générer et envoyer le code d'accès ?"
            }
            message={
              client.hasAccessCode
                ? "L'ancien code sera invalidé. Un email avec le nouveau code de suivi et le code d'accès sera envoyé au client. Le code apparaîtra aussi une fois ici."
                : "Un code d'accès sera créé et envoyé par email au client (avec le code de suivi CLI). Le code apparaîtra aussi une fois ici."
            }
            confirmLabel={client.hasAccessCode ? "Régénérer" : "Générer et envoyer"}
            danger={client.hasAccessCode}
            busy={busyAccess}
            onClose={() => setConfirmRegen(false)}
            onConfirm={() => {
              setBusyAccess(true);
              void api<{
                accessCode: string;
                accessEmailSent?: boolean;
                accessEmailReason?: string;
              }>(`/api/clients/${client.id}/regenerate-access-code`, {
                method: "POST",
                body: "{}",
              })
                .then((r) => {
                  setConfirmRegen(false);
                  if (r.accessEmailSent) {
                    toast.success(
                      `Code envoyé par email. Code (récupérable aussi dans le mail) : ${r.accessCode}`,
                      { duration: 15000 },
                    );
                  } else if (r.accessEmailReason === "smtp_off") {
                    toast.error(
                      `SMTP non configuré. Code généré : ${r.accessCode} (à transmettre manuellement)`,
                      { duration: 15000 },
                    );
                  } else if (r.accessEmailReason === "no_email") {
                    toast.error(
                      `Pas d'email client. Code généré : ${r.accessCode}`,
                      { duration: 15000 },
                    );
                  } else {
                    toast.success(`Code généré : ${r.accessCode}`, { duration: 15000 });
                  }
                  refresh();
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
