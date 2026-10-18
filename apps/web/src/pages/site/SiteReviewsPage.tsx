import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope, faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatDate } from "@/lib/api";
import { useCreateParam } from "@/lib/use-create-param";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EditorFooter, EditorLayout, useItemEditor } from "./editor";
import { ReviewCardPreview } from "./preview";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Banner } from "@/components/ui/Banner";
import { FilterSelect } from "@/components/ui/ListFilters";
import { useUrlFilters } from "@/lib/use-url-filters";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  dateToIso,
  fieldErrorsOf,
  isoToDate,
  LoadState,
  STATUS_OPTIONS,
  StatusBadge,
  todayIso,
  useSiteCollection,
  type FieldErrors,
  type SiteItemStatus,
  type SiteReview,
} from "./shared";

const BASE = "/api/site/reviews";

type ClientOption = { id: string; displayName: string };
type DocOption = { id: string; number: string | null; documentType: string; issueDate: string | null };

/** Témoignage tel que listé : projet et client joints, version d'accord pour ceux de l'espace client. */
type Testimonial = SiteReview & {
  source: "MANUAL" | "CLIENT_SPACE";
  authorFormat: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  consentVersion?: string | null;
  project?: { id: string; name: string } | null;
  client?: { id: string; displayName: string } | null;
};

const fromClientSpace = (r: Testimonial) => r.source === "CLIENT_SPACE";
/** Retrait demandé et pas encore appliqué. */
export const withdrawalPending = (r: SiteReview) => Boolean(r.withdrawalRequestedAt) && r.status !== "WITHDRAWN";

type Filter = "pending" | "published" | "rejected" | "withdrawn" | "all";
const STATE_OF_SLUG = { tous: "all", "a-valider": "pending", "sur-le-site": "published", ecartes: "rejected", retires: "withdrawn" } as const satisfies Record<string, Filter>;
const SLUG_OF_STATE: Record<Filter, string | null> = { all: null, pending: "a-valider", published: "sur-le-site", rejected: "ecartes", withdrawn: "retires" };
function stateOf(r: Testimonial): Exclude<Filter, "all"> | "draft" {
  if (r.rejectedAt) return "rejected";
  if (r.status === "WITHDRAWN") return "withdrawn";
  if (r.status === "PUBLISHED") return "published";
  return fromClientSpace(r) ? "pending" : "draft";
}

/**
 * Méthode (L111-7-2, D111-17/18) : modèle proposé tant qu'Alexandre n'a rien enregistré. Délai indicatif
 * et conservation réels ; la purge de l'IP et du navigateur suit purgeTestimonialProofs (3 ans).
 */
export function methodDraft(email: string | null) {
  return {
    titre: "Comment les témoignages sont recueillis et vérifiés",
    texte: [
      "Les témoignages affichés ici sont recueillis auprès de clients de Kouzia, via leur espace client, à la fin de leur projet. Chacun est relié dans nos outils au client et au projet concerné.",
      "Ils sont publiés sans retouche, avec l'accord de leur auteur, qui choisit la forme de son nom. Aucune contrepartie n'est proposée en échange d'un témoignage.",
      "Tous les témoignages reçus sont publiés, y compris critiques, sauf s'ils sont hors sujet, contiennent des propos injurieux ou des données personnelles ; leur auteur est alors prévenu du motif. Un témoignage est validé et publié en général sous 7 jours.",
      "Ils sont classés du plus récent au plus ancien et restent affichés tant que leur auteur ne demande pas leur retrait, possible à tout moment depuis son espace client.",
      `La preuve de l'accord (date, texte de l'accord, et l'adresse IP et le navigateur utilisés) est conservée pendant la publication ; l'adresse IP et le navigateur sont effacés 3 ans après le retrait.${email ? ` Pour toute question : ${email}.` : ""}`,
    ].join("\n\n"),
  };
}

/** État d'un témoignage : à valider, écarté, ou statut de publication ; retrait demandé en plus. */
function TestimonialState({ r }: { r: Testimonial }) {
  const s = stateOf(r);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {s === "pending" ? <Badge tone="blue">À valider</Badge> : s === "rejected" ? <Badge tone="red">Écarté</Badge> : <StatusBadge row={r} />}
      {withdrawalPending(r) ? <Badge tone="red">Retrait demandé</Badge> : null}
    </span>
  );
}

const emptyForm = {
  author: "",
  reviewedOn: todayIso(),
  experienceOn: "",
  clientId: "",
  invoiceId: "",
  text: "",
  googleUrl: "",
  consentAt: "",
  consentChannel: "",
  consentProof: "",
  withdrawalRequestedAt: "",
  status: "DRAFT" as SiteItemStatus,
};

export function SiteReviewsPage() {
  const { rows: raw, loading, error, reload } = useSiteCollection<Testimonial>(BASE);
  // Classement annoncé sur le site (D111-17) : du plus récent au plus ancien, pas d'ordre manuel.
  const rows = [...raw].sort((a, b) => b.reviewedOn.localeCompare(a.reviewedOn));
  const pendingCount = rows.filter((r) => stateOf(r) === "pending").length;
  const filters = useUrlFilters();
  const activeFilter: Filter = STATE_OF_SLUG[filters.pick("statut", Object.keys(STATE_OF_SLUG) as Array<keyof typeof STATE_OF_SLUG>, "tous")];
  const withdrawals = rows.filter(withdrawalPending).length;
  const withdrawalsOnly = withdrawals > 0 && filters.params.get("retrait") === "1";
  const inState = (r: Testimonial) => activeFilter === "all" || stateOf(r) === activeFilter || (activeFilter === "pending" && stateOf(r) === "draft");
  const visible = rows.filter((r) => inState(r) && (!withdrawalsOnly || withdrawalPending(r)));

  const navigate = useNavigate();
  useCreateParam(() => navigate("/site/avis/nouveau", { replace: true }));

  const columns: DataColumn<Testimonial>[] = [
    {
      name: "Auteur",
      grow: 2,
      cell: (r) => (
        <div className="min-w-0 py-2">
          <Link to={`/site/avis/${r.id}`} className="block max-w-full truncate font-medium hover:text-[var(--primary)]">
            {r.author}
          </Link>
          <p className="truncate text-xs text-[var(--muted)]">{r.text}</p>
        </div>
      ),
    },
    {
      name: "Origine",
      width: "10rem",
      showFrom: 1280,
      cell: (r) => (fromClientSpace(r) ? (r.project ? `Espace client, ${r.project.name}` : "Espace client") : "Saisi dans l'ERP"),
    },
    { name: "Reçu le", width: "8rem", showFrom: 1280, cell: (r) => formatDate(r.reviewedOn) },
    { name: "Statut", width: "11rem", cell: (r) => <TestimonialState r={r} /> },
  ];

  const count = (f: Exclude<Filter, "all">) => rows.filter((r) => stateOf(r) === f || (f === "pending" && stateOf(r) === "draft")).length;

  return (
    <div>
      <PageHeader
        title="Témoignages"
        subtitle="Recueillis auprès de vos clients en fin de projet, depuis leur espace client. Publiés sans retouche, du plus récent au plus ancien ; vos avis Google restent sur Google."
        actions={
          <ButtonLink to="/site/avis/nouveau">
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouveau témoignage
          </ButtonLink>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <MethodCard />
        {pendingCount ? (
          <Banner
            level="info"
            className="mb-4"
            action={
              activeFilter === "pending" ? undefined : (
                <Link to="?statut=a-valider" replace className="link inline-flex min-h-11 items-center text-sm font-medium">
                  {pendingCount > 1 ? "Afficher ces témoignages" : "Afficher ce témoignage"}
                </Link>
              )
            }
          >
            {pendingCount > 1 ? `${pendingCount} témoignages attendent votre validation.` : "1 témoignage attend votre validation."}
          </Banner>
        ) : null}
        {withdrawals ? (
          <Banner
            level="warning"
            className="mb-4"
            action={
              <Link to={withdrawalsOnly ? "?" : "?retrait=1"} replace className="link inline-flex min-h-11 items-center text-sm font-medium">
                {withdrawalsOnly ? "Afficher tous les témoignages" : withdrawals > 1 ? "Afficher ces témoignages" : "Afficher ce témoignage"}
              </Link>
            }
          >
            {withdrawals > 1 ? `${withdrawals} retraits demandés sont à appliquer.` : "1 retrait demandé est à appliquer."}
          </Banner>
        ) : null}
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={visible}
            onRowClick={(r) => navigate(`/site/avis/${r.id}`)}
            countLabel={visible.length > 1 ? "témoignages" : "témoignage"}
            emptyTitle={activeFilter === "pending" ? "Aucun témoignage à valider" : "Aucun témoignage"}
            emptyHint="Les témoignages arrivent ici quand un client en dépose un depuis son espace, à la fin de son projet."
            toolbar={
              <FilterSelect
                label="État"
                value={activeFilter}
                onChange={(f) => filters.set({ statut: SLUG_OF_STATE[f], retrait: null })}
                options={[
                  { id: "all", label: "Tous les états", count: rows.length },
                  { id: "pending", label: "À valider", count: count("pending") },
                  { id: "published", label: "Sur le site", count: count("published") },
                  { id: "rejected", label: "Écartés", count: count("rejected") },
                  { id: "withdrawn", label: "Retirés", count: count("withdrawn") },
                ]}
              />
            }
            renderMobileCard={(r) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <Link to={`/site/avis/${r.id}`} className="block min-h-11 min-w-0 flex-1">
                  <span className="line-clamp-2 break-words font-medium">{r.author}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">{r.text}</span>
                  <span className="mt-1 block">
                    <TestimonialState r={r} />
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

/**
 * Texte « Comment les témoignages sont recueillis et vérifiés » (L111-7-2, D111-17/18), publié avec eux.
 * Tant qu'il n'est pas enregistré, un modèle est proposé en brouillon : rien ne part sans relecture.
 */
function MethodCard() {
  const [saved, setSaved] = useState<{ titre: string; texte: string } | null | undefined>(undefined);
  const [form, setForm] = useState({ titre: "", texte: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ avisMethode: { titre: string; texte: string } | null; infos: { email: string } | null }>("/api/site/texts")
      .then((t) => {
        setSaved(t.avisMethode);
        setForm(t.avisMethode ?? methodDraft(t.infos?.email ?? null));
      })
      .catch(() => setSaved(null));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      setSaved(await api<{ titre: string; texte: string }>("/api/site/texts/avisMethode", { method: "PUT", body: JSON.stringify(form) }));
      toast.success("Méthode enregistrée");
    } catch (err) {
      setErrors(fieldErrorsOf(err));
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  if (saved === undefined) return null;
  const draft = saved === null;
  return (
    <details className="ui-card group mb-4 p-4 sm:p-5" open={draft}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">Comment les témoignages sont recueillis et vérifiés</span>
        {draft ? <Badge tone="amber">Modèle à relire</Badge> : <Badge tone="green">Enregistré</Badge>}
      </summary>
      <form onSubmit={onSubmit} noValidate className="mt-3 space-y-4">
        <p className="text-sm text-[var(--muted)]">
          Texte obligatoire dès qu'un témoignage est publié (Code de la consommation, L111-7-2) : il est affiché avec eux sur le site.
          {draft ? " Ce modèle n'est pas encore enregistré : le relire, l'ajuster puis l'enregistrer." : ""}
        </p>
        <Field label="Titre" error={errors.titre}>
          <Input value={form.titre} maxLength={120} onChange={(e) => setForm({ ...form, titre: e.target.value })} />
        </Field>
        <Field label="Texte" error={errors.texte}>
          <Textarea rows={12} value={form.texte} onChange={(e) => setForm({ ...form, texte: e.target.value })} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? "Enregistrement…" : draft ? "Enregistrer après relecture" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </details>
  );
}

type ReviewForm = typeof emptyForm;

/** Règles de publication (L111-7-2, D111-17) reprises avant l'envoi ; l'API garde le dernier mot. */
function reviewErrors(form: ReviewForm, item: Testimonial | null): FieldErrors {
  const e: FieldErrors = {};
  const clientSpace = Boolean(item && fromClientSpace(item));
  if (!form.author.trim()) e.author = "Nom affiché obligatoire.";
  if (!form.text.trim()) e.text = "Texte obligatoire.";
  if (!form.reviewedOn) e.reviewedOn = "Date de réception obligatoire.";
  if (form.status === "PUBLISHED") {
    if (!form.consentAt) e.consentAt = "Accord de l'auteur requis avant de publier.";
    if (!clientSpace && !form.consentProof.trim()) e.consentProof = "Preuve de l'accord requise avant de publier.";
    if (!form.clientId) e.clientId = "Client requis : il prouve que le témoignage vient d'un vrai client.";
    if (!form.experienceOn) e.experienceOn = "Date de l'expérience requise : elle est affichée près du témoignage.";
  }
  return e;
}

function reviewBody(form: ReviewForm, item: Testimonial | null) {
  return {
    author: form.author,
    reviewedOn: form.reviewedOn,
    text: form.text,
    // Jamais de note publiée (charte) : la valeur éventuelle d'avant est gardée telle quelle.
    rating: item?.rating ?? null,
    googleUrl: form.googleUrl.trim() || null,
    consentAt: dateToIso(form.consentAt),
    consentChannel: form.consentChannel.trim() || null,
    consentProof: form.consentProof.trim() || null,
    withdrawalRequestedAt: dateToIso(form.withdrawalRequestedAt),
    experienceOn: form.experienceOn || null,
    clientId: form.clientId || null,
    invoiceId: form.invoiceId || null,
    alteredWithConsent: false,
    status: form.status,
  };
}

export function SiteReviewPage() {
  const { id = "" } = useParams();
  const creating = id === "nouveau";
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [docs, setDocs] = useState<DocOption[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [mailto, setMailto] = useState<{ href: string | null; author: string } | null>(null);
  const ed = useItemEditor<Testimonial, ReviewForm>({
    base: BASE,
    id,
    creating,
    empty: { ...emptyForm, reviewedOn: todayIso() },
    toForm: (r) => ({
      author: r.author,
      reviewedOn: r.reviewedOn,
      text: r.text,
      googleUrl: r.googleUrl ?? "",
      consentAt: isoToDate(r.consentAt),
      consentChannel: r.consentChannel ?? "",
      consentProof: r.consentProof ?? "",
      withdrawalRequestedAt: isoToDate(r.withdrawalRequestedAt),
      experienceOn: r.experienceOn ?? "",
      clientId: r.clientId ?? "",
      invoiceId: r.invoiceId ?? "",
      status: r.status,
    }),
    toBody: reviewBody,
    validate: reviewErrors,
    itemPath: (r) => `/site/avis/${r.id}`,
    listPath: "/site/avis",
    labels: { created: "Témoignage créé : la suite s'enregistre toute seule", deleted: "Témoignage supprimé", notFound: "Témoignage introuvable" },
  });
  const { form, set, setForm, errors, item: editing } = ed;

  // Clients pour la preuve de la relation ; documents émis du client choisi.
  useEffect(() => {
    api<ClientOption[]>("/api/clients")
      .then((list) => setClients([...list].sort((a, b) => a.displayName.localeCompare(b.displayName, "fr"))))
      .catch(() => toast.error("Liste des clients indisponible"));
  }, []);
  useEffect(() => {
    if (!form.clientId) {
      setDocs([]);
      return;
    }
    api<DocOption[]>(`/api/invoices?type=ALL&pageSize=100&clientId=${encodeURIComponent(form.clientId)}`)
      .then((list) => setDocs(list.filter((d) => d.number)))
      .catch(() => setDocs([]));
  }, [form.clientId]);

  const clientSpace = Boolean(editing && fromClientSpace(editing));
  // Mots du client (espace client) ou texte publié : jamais modifiés dans l'ERP.
  const locked = Boolean(editing?.publishedAt) || clientSpace;

  async function publish() {
    if (!editing) return;
    ed.setBusy(true);
    try {
      await ed.auto.flush();
      await api(`${BASE}/${editing.id}/publish`, { method: "POST" });
      await ed.load();
      toast.success("Témoignage validé : il sera en ligne à la prochaine publication");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Publication impossible");
    } finally {
      ed.setBusy(false);
    }
  }

  async function reject(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (reason.trim().length < 3) {
      setReasonError("Motif requis : il est communiqué à l'auteur.");
      return;
    }
    ed.setBusy(true);
    try {
      const res = await api<{ mailto: string | null }>(`${BASE}/${editing.id}/reject`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      setRejecting(false);
      setMailto({ href: res.mailto, author: editing.author });
      toast.success("Témoignage écarté");
      await ed.load();
    } catch (err) {
      setReasonError(err instanceof Error ? err.message : "Écartement impossible");
    } finally {
      ed.setBusy(false);
    }
  }

  const temoignage = (
    <div className="space-y-4">
      {clientSpace ? (
        <p className="rounded-[var(--radius-sm)] bg-[var(--surface-raised)] p-3 text-sm">
          Déposé par le client depuis son espace : ses mots et son nom ne se modifient pas. L'afficher sur le site tel quel ou l'écarter avec un
          motif (onglet Publication).
        </p>
      ) : locked ? (
        <p className="rounded-[var(--radius-sm)] bg-[var(--surface-raised)] p-3 text-sm">
          Publié : auteur, date et texte sont figés. Pour corriger, le retirer puis le recréer.
        </p>
      ) : null}
      <Field label="Nom affiché" hint={clientSpace ? "Forme choisie par le client." : "Sous la forme choisie par l'auteur (ex. Marie D.)."} error={errors.author}>
        <Input required autoComplete="off" disabled={locked} value={form.author} onChange={(e) => set("author", e.target.value)} />
      </Field>
      <Field
        label="Texte du témoignage"
        hint={clientSpace ? undefined : "Recopiez le témoignage exactement tel que le client l'a écrit, fautes comprises ; pour une correction, demandez-lui un nouveau texte."}
        error={errors.text}
      >
        <Textarea required rows={7} disabled={locked} value={form.text} onChange={(e) => set("text", e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reçu le" hint="Affiché comme date de publication." error={errors.reviewedOn}>
          <Input required type="date" disabled={locked} value={form.reviewedOn} onChange={(e) => set("reviewedOn", e.target.value)} />
        </Field>
        <Field label="Date de l'expérience" hint="Fin de la prestation, affichée près du témoignage." error={errors.experienceOn}>
          <Input type="date" value={form.experienceOn} onChange={(e) => set("experienceOn", e.target.value)} />
        </Field>
      </div>
    </div>
  );

  const preuve = clientSpace && editing ? (
    <div className="space-y-1 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] p-3 text-sm">
      <p>
        <span className="text-[var(--muted)]">Projet : </span>
        {editing.project?.name ?? "supprimé"}
        {editing.client ? <span className="text-[var(--muted)]"> ({editing.client.displayName})</span> : null}
      </p>
      <p>
        <span className="text-[var(--muted)]">Accord : </span>
        donné le {formatDate(editing.consentAt)} depuis l'espace client
        {editing.consentVersion ? `, texte d'accord du ${formatDate(editing.consentVersion)}` : ""}
      </p>
      {editing.rejectedAt ? (
        <p className="text-[var(--danger)]">
          Écarté le {formatDate(editing.rejectedAt)} : {editing.rejectionReason}
        </p>
      ) : null}
    </div>
  ) : (
    <div className="space-y-4">
      <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
        <legend className="px-1 text-sm font-medium">Preuve que c'est un client (jamais publiée)</legend>
        <Field label="Client" error={errors.clientId}>
          <Select value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value, invoiceId: "" }))}>
            <option value="">Choisir…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Devis ou facture (facultatif)" hint="Le document de la prestation dont parle le témoignage." error={errors.invoiceId}>
          <Select value={form.invoiceId} disabled={!form.clientId} onChange={(e) => set("invoiceId", e.target.value)}>
            <option value="">{form.clientId ? (docs.length ? "Aucun" : "Aucun document émis") : "Choisir d'abord le client"}</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.documentType === "QUOTE" ? "Devis" : d.documentType === "CREDIT_NOTE" ? "Avoir" : "Facture"} {d.number}
                {d.issueDate ? ` du ${formatDate(d.issueDate)}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
        <legend className="px-1 text-sm font-medium">Accord de l'auteur (jamais publié)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date de l'accord" error={errors.consentAt}>
            <Input type="date" value={form.consentAt} onChange={(e) => set("consentAt", e.target.value)} />
          </Field>
          <Field label="Canal" hint="E-mail, courrier…" error={errors.consentChannel}>
            <Input autoComplete="off" value={form.consentChannel} onChange={(e) => set("consentChannel", e.target.value)} />
          </Field>
        </div>
        <Field label="Preuve" hint="Copie du message ou du papier d'accord, obligatoire pour publier. Chiffrée dans l'ERP." error={errors.consentProof}>
          <Textarea rows={3} value={form.consentProof} onChange={(e) => set("consentProof", e.target.value)} />
        </Field>
      </fieldset>
    </div>
  );

  const canPublishFromSpace = clientSpace && editing && editing.status !== "PUBLISHED" && !editing.publishedAt && !editing.rejectedAt;
  const canReject = editing && !editing.publishedAt && editing.status !== "PUBLISHED" && !editing.rejectedAt;
  const publication = (
    <div className="space-y-4">
      <Field
        label="Retrait demandé le (facultatif)"
        hint="Si l'auteur demande le retrait : passer en « Retiré du site » ; il sort du site à la prochaine publication."
        error={errors.withdrawalRequestedAt}
      >
        <Input type="date" value={form.withdrawalRequestedAt} onChange={(e) => set("withdrawalRequestedAt", e.target.value)} />
      </Field>
      {!clientSpace || editing?.status === "PUBLISHED" || editing?.status === "WITHDRAWN" ? (
        <Field label="Statut" error={errors.status}>
          <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canPublishFromSpace ? (
          <Button disabled={ed.busy} onClick={() => void publish()}>
            Afficher sur le site
          </Button>
        ) : null}
        {canReject ? (
          <Button
            variant="danger-ghost"
            disabled={ed.busy}
            onClick={() => {
              setReason("");
              setReasonError(undefined);
              setRejecting(true);
            }}
          >
            Écarter…
          </Button>
        ) : null}
        {editing && !editing.publishedAt && !clientSpace ? (
          <Button variant="danger-ghost" disabled={ed.busy} onClick={() => setDeleting(true)}>
            Supprimer le témoignage
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        back={{ to: "/site/avis", label: "Témoignages" }}
        title={creating ? "Nouveau témoignage" : editing ? `Témoignage de ${editing.author}` : "Témoignage"}
        subtitle={editing ? <TestimonialState r={editing} /> : undefined}
      />
      <LoadState loading={ed.loading} error={ed.loadError} onRetry={() => void ed.load()}>
        <form onSubmit={ed.onSubmit} noValidate>
          <EditorLayout
            label="Sections du témoignage"
            tabs={[
              { id: "temoignage", label: "Témoignage", content: temoignage, errors: ed.countErrors(["author", "text", "reviewedOn", "experienceOn"]) },
              { id: "preuve", label: "Preuve et accord", content: preuve, errors: ed.countErrors(["clientId", "invoiceId", "consentAt", "consentChannel", "consentProof"]) },
              { id: "publication", label: "Publication", content: publication, errors: ed.countErrors(["status", "withdrawalRequestedAt"]) },
            ]}
            preview={() => (
              <ReviewCardPreview author={form.author} text={form.text} reviewedOn={form.reviewedOn || null} experienceOn={form.experienceOn || null} />
            )}
            footer={<EditorFooter auto={ed.auto} creating={creating} busy={ed.busy} createLabel="Créer le témoignage" />}
          />
        </form>
      </LoadState>

      <Modal open={rejecting} onClose={() => (ed.busy ? undefined : setRejecting(false))} title="Écarter ce témoignage ?">
        <form onSubmit={reject} noValidate className="space-y-4">
          <p className="rounded-[var(--radius-sm)] bg-[var(--warning-soft)] p-3 text-sm">
            Un témoignage ne peut pas être écarté parce qu'il est négatif. Seuls les témoignages hors sujet, injurieux ou contenant des données
            personnelles le sont, et l'auteur doit être prévenu du motif (Code de la consommation, D111-19).
          </p>
          <Field label="Motif" hint="Communiqué à l'auteur, en une phrase claire." error={reasonError}>
            <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ModalActions>
            <Button variant="secondary" disabled={ed.busy} onClick={() => setRejecting(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="danger" disabled={ed.busy}>
              {ed.busy ? "…" : "Écarter"}
            </Button>
          </ModalActions>
        </form>
      </Modal>

      <Modal open={Boolean(mailto)} onClose={() => setMailto(null)} title="Prévenir l'auteur">
        <p className="text-sm">
          {mailto?.href
            ? `Écrivez à ${mailto.author} pour lui donner le motif : le message est pré-rempli, sans reprendre son témoignage.`
            : `Aucune adresse e-mail pour ${mailto?.author ?? "l'auteur"} : le prévenir par un autre moyen.`}
        </p>
        <ModalActions>
          <Button variant="secondary" onClick={() => setMailto(null)}>
            Fermer
          </Button>
          {mailto?.href ? (
            <a
              href={mailto.href}
              onClick={() => setMailto(null)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] px-4 text-sm font-semibold btn-accent"
            >
              <FontAwesomeIcon icon={faEnvelope} className="h-3.5 w-3.5" aria-hidden />
              Écrire à l'auteur
            </a>
          ) : null}
        </ModalActions>
      </Modal>

      <ConfirmDialog
        open={deleting}
        title="Supprimer ce témoignage ?"
        message="Il n'a jamais été publié : il disparaît de l'ERP, preuve d'accord comprise."
        confirmLabel="Supprimer"
        danger
        busy={ed.busy}
        onConfirm={() => void ed.remove().catch(() => setDeleting(false))}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
