import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faPaperPlane, faEnvelope } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Field, Input } from "@/components/ui/Field";
import { DataTable, type TableColumn } from "@/components/ui/DataTable";
import {
  ClientFormEditor,
  clientToForm,
  type Client,
} from "@/components/clients/ClientForm";
import { ClientEmailLink } from "@/components/clients/ClientEmailLink";
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
      name: "Code suivi",
      selector: (c) => c.clientNumber ?? "-",
      sortable: true,
      width: "140px",
      cell: (c) => (
        <span className="font-mono text-sm font-semibold text-[var(--primary)]">
          {c.clientNumber ?? "-"}
        </span>
      ),
    },
    {
      name: "Nom",
      selector: (c) => c.displayName,
      sortable: true,
      grow: 2,
      cell: (c) => (
        <button
          type="button"
          className="link text-left font-medium"
          onClick={() => navigate(`/clients/${c.id}`)}
        >
          {c.displayName}
        </button>
      ),
    },
    {
      name: "Type",
      selector: (c) => c.type,
      sortable: true,
      width: "120px",
      cell: (c) => (
        <Badge tone={c.type === "B2B" ? "teal" : "neutral"}>
          {c.type === "B2B" ? "Pro" : "Particulier"}
        </Badge>
      ),
    },
    {
      name: "Contact",
      grow: 2,
      cell: (c) => (
        <div className="text-[var(--muted)]">
          <div className="truncate">{c.email ?? "-"}</div>
          <div className="text-xs">{c.phone ?? ""}</div>
        </div>
      ),
    },
    {
      name: "Dernier échange",
      grow: 2,
      cell: (c) =>
        c.lastExchange ? (
          <Link
            to={`/clients/${c.id}?tab=messages`}
            className="block text-left text-sm hover:underline"
            title={c.lastExchange.subject}
          >
            <span className="text-[var(--text)]">{formatDate(c.lastExchange.lastMessageAt)}</span>
            <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
              {c.lastExchange.subject}
            </span>
          </Link>
        ) : (
          <span className="text-sm text-[var(--muted)]">-</span>
        ),
    },
    {
      name: "Ville",
      selector: (c) => c.city ?? "",
      sortable: true,
      width: "160px",
      cell: (c) => <span className="text-[var(--muted)]">{c.city ?? "-"}</span>,
    },
    {
      name: "",
      grow: 0,
      width: "9rem",
      right: true,
      style: { whiteSpace: "nowrap" },
      cell: (c) => (
        <div className="flex justify-end gap-1">
          {c.email ? (
            <Button
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() =>
                navigate(`/inbox/compose?clientId=${encodeURIComponent(c.id)}&to=${encodeURIComponent(c.email ?? "")}`)
              }
            >
              <FontAwesomeIcon icon={faEnvelope} className="h-3 w-3" />
              Écrire
            </Button>
          ) : null}
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
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Carnet d'adresses : particuliers et professionnels"
        actions={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(true)}>
              <FontAwesomeIcon icon={faPaperPlane} className="h-3.5 w-3.5" />
              Inviter par email
            </Button>
            <Button onClick={openCreate}>
              <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
              Nouveau client
            </Button>
          </>
        }
      />

      {loading ? (
        <Card>
          <p className="p-8 text-sm text-[var(--muted)]">Chargement…</p>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {(
              [
                ["all", "Tous"],
                ["with", "Ayant une correspondance"],
                ["without", "Sans échange"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`rounded-full px-3 py-1 text-xs ${
                  correspondenceFilter === id
                    ? "bg-[var(--primary)] text-white"
                    : "bg-[var(--surface-muted)] text-[var(--muted)]"
                }`}
                onClick={() => setCorrespondenceFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <DataTable
          columns={columns}
          data={clients}
          pagination
          perPage={25}
          searchable={["displayName", "clientNumber", "email", "city", "phone"]}
          searchPlaceholder="Rechercher nom, email, ville…"
          emptyTitle="Aucun client"
          emptyHint="Créez votre premier contact pour facturer et suivre les échanges."
        />
        </>
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
          <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
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
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
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
            <Button onClick={() => setEditOpen(true)}>Modifier</Button>
          </>
        }
      />

      <Card className="space-y-4 px-5 py-4">
        <div>
          <p className="text-xs font-medium text-[var(--muted)]">
            Code de suivi (identifiant public)
          </p>
          <p className="mt-1 font-mono text-xl font-semibold text-[var(--primary)]">
            {client.clientNumber ?? "Non attribué"}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Identifiant client immuable, utilisé pour le suivi public (kouzia.fr/suivi).
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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-3 p-5 text-sm lg:col-span-2">
          <h2 className="font-semibold">Coordonnées</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
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
                    className="link-row"
                  >
                    <span>
                      {d.number ?? "Brouillon"} ·{" "}
                      {d.documentType === "QUOTE" ? "Devis" : "Facture"}
                    </span>
                    <span className="link-row-muted tabular-nums">
                      {formatEUR(d.totalCents)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ClientMessagesTab clientId={client.id} />

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
