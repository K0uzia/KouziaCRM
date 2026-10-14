import { useEffect, useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatDate } from "@/lib/api";
import { useCreateParam } from "@/lib/use-create-param";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { StatStrip } from "@/components/ui/StatStrip";
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

/** Méthode (L111-7-2, D111-17/18) : modèle proposé tant qu'Alexandre n'a rien enregistré ; vrai aujourd'hui, sans délai promis. */
export function methodDraft(email: string | null) {
  return {
    titre: "Comment les avis sont recueillis et vérifiés",
    texte: [
      "Les avis affichés ici viennent de clients pour qui Kouzia a réalisé une prestation : chaque avis est relié, dans nos outils, au client et à son devis ou à sa facture.",
      "Ils sont repris de la fiche Google de Kouzia avec l'accord écrit de leur auteur, qui choisit la forme de son nom. Le texte est publié exactement tel que l'auteur l'a écrit, sans aucune retouche.",
      "Aucune contrepartie n'est proposée en échange d'un avis.",
      "Les avis sont classés du plus récent au plus ancien et restent en ligne tant que leur auteur n'en demande pas le retrait.",
      "Ne sont pas publiés : les avis de personnes qui ne sont pas clientes et ceux dont l'auteur n'a pas donné son accord.",
      `Un auteur peut demander la modification ou le retrait de son avis${email ? ` en écrivant à ${email}` : ""}.`,
    ].join("\n\n"),
  };
}

const emptyForm = {
  author: "",
  reviewedOn: todayIso(),
  experienceOn: "",
  clientId: "",
  invoiceId: "",
  text: "",
  rating: "",
  googleUrl: "",
  consentAt: "",
  consentChannel: "",
  consentProof: "",
  withdrawalRequestedAt: "",
  status: "DRAFT" as SiteItemStatus,
};

/** Retrait demandé par l'auteur et pas encore appliqué : à traiter sous 7 jours. */
export const withdrawalPending = (r: SiteReview) => Boolean(r.withdrawalRequestedAt) && r.status !== "WITHDRAWN";

export function SiteReviewsPage() {
  const { rows: raw, loading, error, reload } = useSiteCollection<SiteReview>(BASE);
  // Classement annoncé sur le site (D111-17) : du plus récent au plus ancien, pas d'ordre manuel.
  const rows = [...raw].sort((a, b) => b.reviewedOn.localeCompare(a.reviewedOn));
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [docs, setDocs] = useState<DocOption[]>([]);
  const [editing, setEditing] = useState<SiteReview | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function openForm(r: SiteReview | null) {
    setEditing(r);
    setErrors({});
    setForm(
      r
        ? {
            author: r.author,
            reviewedOn: r.reviewedOn,
            text: r.text,
            rating: r.rating ? String(r.rating) : "",
            googleUrl: r.googleUrl ?? "",
            consentAt: isoToDate(r.consentAt),
            consentChannel: r.consentChannel ?? "",
            consentProof: r.consentProof ?? "",
            withdrawalRequestedAt: isoToDate(r.withdrawalRequestedAt),
            experienceOn: r.experienceOn ?? "",
            clientId: r.clientId ?? "",
            invoiceId: r.invoiceId ?? "",
            status: r.status,
          }
        : { ...emptyForm, reviewedOn: todayIso() },
    );
    setOpen(true);
  }
  useCreateParam(() => openForm(null));

  // Clients : chargés à la première ouverture du formulaire. Documents émis du client choisi.
  useEffect(() => {
    if (!open || clients.length) return;
    api<ClientOption[]>("/api/clients")
      .then((list) => setClients([...list].sort((a, b) => a.displayName.localeCompare(b.displayName, "fr"))))
      .catch(() => toast.error("Liste des clients indisponible"));
  }, [open, clients.length]);
  useEffect(() => {
    if (!open || !form.clientId) {
      setDocs([]);
      return;
    }
    api<DocOption[]>(`/api/invoices?type=ALL&pageSize=100&clientId=${encodeURIComponent(form.clientId)}`)
      .then((list) => setDocs(list.filter((d) => d.number)))
      .catch(() => setDocs([]));
  }, [open, form.clientId]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const locked = Boolean(editing?.publishedAt);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (form.status === "PUBLISHED") {
      const missing: FieldErrors = {};
      if (!form.consentAt) missing.consentAt = "Accord de l'auteur requis avant de mettre l'avis sur le site.";
      if (!form.clientId) missing.clientId = "Client requis : il prouve que l'avis vient d'un vrai client.";
      if (!form.experienceOn) missing.experienceOn = "Date de l'expérience requise : elle est affichée près de l'avis.";
      if (Object.keys(missing).length) {
        setErrors(missing);
        return;
      }
    }
    setBusy(true);
    setErrors({});
    const body = {
      author: form.author,
      reviewedOn: form.reviewedOn,
      text: form.text,
      rating: form.rating ? Number(form.rating) : null,
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
    try {
      await api(editing ? `${BASE}/${editing.id}` : BASE, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      toast.success(editing ? "Avis enregistré" : "Avis ajouté");
      setOpen(false);
      await reload();
    } catch (err) {
      setErrors(fieldErrorsOf(err));
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    try {
      await api(`${BASE}/${editing.id}`, { method: "DELETE" });
      toast.success("Avis supprimé");
      setDeleting(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const consentBadge = (r: SiteReview) =>
    r.consentAt ? (
      <span className="text-sm">Le {formatDate(r.consentAt)}</span>
    ) : (
      <Badge tone="red">Accord manquant</Badge>
    );

  const columns: DataColumn<SiteReview>[] = [
    {
      name: "Auteur",
      grow: 2,
      cell: (r) => (
        <div className="min-w-0 py-2">
          <button type="button" onClick={() => openForm(r)} className="block max-w-full truncate text-left font-medium hover:text-[var(--primary)]">
            {r.author}
          </button>
          <p className="truncate text-xs text-[var(--muted)]">{r.text}</p>
        </div>
      ),
    },
    { name: "Date de l'avis", width: "9rem", showFrom: 1280, cell: (r) => formatDate(r.reviewedOn) },
    { name: "Accord", width: "10rem", cell: consentBadge },
    {
      name: "Statut",
      width: "11rem",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge row={r} />
          {withdrawalPending(r) ? <Badge tone="red">Retrait demandé</Badge> : null}
        </div>
      ),
    },
    {
      name: "Client",
      width: "9rem",
      showFrom: 1280,
      cell: (r) => (r.clientId ? "Lié" : <Badge tone={r.status === "PUBLISHED" ? "red" : "neutral"}>Non lié</Badge>),
    },
  ];

  const missingConsent = rows.filter((r) => r.status === "PUBLISHED" && !r.consentAt).length;
  const withdrawals = rows.filter(withdrawalPending).length;

  return (
    <div>
      <PageHeader
        title="Avis"
        subtitle="Avis Google de vrais clients, repris sur kouzia.com avec leur accord écrit. Classés du plus récent au plus ancien ; un avis publié ne se modifie plus."
        actions={
          <Button onClick={() => openForm(null)}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvel avis
          </Button>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <StatStrip
          className="mb-4"
          items={[
            { label: "Sur le site", value: rows.filter((r) => r.status === "PUBLISHED").length, tone: "success" },
            { label: "Accords manquants", shortLabel: "Sans accord", value: missingConsent, tone: missingConsent ? "danger" : "default" },
            { label: "Retraits à faire", shortLabel: "Retraits", value: withdrawals, tone: withdrawals ? "warning" : "default" },
          ]}
        />
        <MethodCard />
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => openForm(r)}
            countLabel="avis"
            emptyTitle="Aucun avis"
            emptyHint="Ajoutez un avis Google dont l'auteur a donné son accord écrit."
            renderMobileCard={(r) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <button type="button" onClick={() => openForm(r)} className="min-h-11 min-w-0 flex-1 text-left">
                  <span className="line-clamp-2 break-words font-medium">{r.author}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusBadge row={r} />
                    {r.consentAt ? null : <Badge tone="red">Accord manquant</Badge>}
                    {withdrawalPending(r) ? <Badge tone="red">Retrait demandé</Badge> : null}
                  </span>
                </button>
              </div>
            )}
          />
        </Card>
      </LoadState>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Avis de ${editing.author}` : "Nouvel avis"}
        description={locked ? "Avis publié : auteur, date et texte sont figés. Pour corriger, le retirer puis le recréer." : undefined}
        fullScreenMobile
        wide
      >
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <Field label="Nom affiché" hint="Sous la forme choisie par l'auteur (ex. Marie D.)." error={errors.author}>
            <Input required disabled={locked} value={form.author} onChange={(e) => set("author", e.target.value)} />
          </Field>
          <Field label="Date de l'avis" error={errors.reviewedOn}>
            <Input required type="date" disabled={locked} value={form.reviewedOn} onChange={(e) => set("reviewedOn", e.target.value)} />
          </Field>
          <Field label="Date de l'expérience" hint="Date de la prestation dont parle l'avis, affichée près de l'avis." error={errors.experienceOn}>
            <Input type="date" value={form.experienceOn} onChange={(e) => set("experienceOn", e.target.value)} />
          </Field>
          <Field
            label="Texte de l'avis"
            hint="Recopiez l'avis exactement tel que le client l'a écrit, fautes comprises ; pour une correction, demandez-lui un nouveau texte."
            error={errors.text}
          >
            <Textarea required rows={5} disabled={locked} value={form.text} onChange={(e) => set("text", e.target.value)} />
          </Field>

          <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
            <legend className="px-1 text-sm font-medium">Preuve que c'est un client (jamais publiée)</legend>
            <Field label="Client" error={errors.clientId}>
              <Select
                value={form.clientId}
                onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value, invoiceId: "" }))}
              >
                <option value="">Choisir…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Devis ou facture (facultatif)" hint="Le document de la prestation dont parle l'avis." error={errors.invoiceId}>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Note (facultatif)" hint="Gardée dans l'ERP, jamais publiée." error={errors.rating}>
              <Select value={form.rating} onChange={(e) => set("rating", e.target.value)}>
                <option value="">Non renseignée</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n} sur 5
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Lien de l'avis Google (facultatif)" error={errors.googleUrl}>
              <Input type="url" inputMode="url" value={form.googleUrl} onChange={(e) => set("googleUrl", e.target.value)} />
            </Field>
          </div>

          <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
            <legend className="px-1 text-sm font-medium">Accord de l'auteur (jamais publié)</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date de l'accord" error={errors.consentAt}>
                <Input type="date" value={form.consentAt} onChange={(e) => set("consentAt", e.target.value)} />
              </Field>
              <Field label="Canal" hint="E-mail, SMS, courrier…" error={errors.consentChannel}>
                <Input value={form.consentChannel} onChange={(e) => set("consentChannel", e.target.value)} />
              </Field>
            </div>
            <Field label="Preuve" hint="Copie du message d'accord. Chiffrée dans l'ERP." error={errors.consentProof}>
              <Textarea rows={3} value={form.consentProof} onChange={(e) => set("consentProof", e.target.value)} />
            </Field>
            <Field
              label="Retrait demandé le (facultatif)"
              hint="Si l'auteur retire son accord : passer l'avis en « Retiré du site » et publier sous 7 jours."
              error={errors.withdrawalRequestedAt}
            >
              <Input type="date" value={form.withdrawalRequestedAt} onChange={(e) => set("withdrawalRequestedAt", e.target.value)} />
            </Field>
          </fieldset>

          <Field label="Statut" hint="« Sur le site » exige l'accord de l'auteur, le client et la date de l'expérience." error={errors.status}>
            <Select value={form.status} onChange={(e) => set("status", e.target.value as SiteItemStatus)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          <ModalActions>
            {editing && !editing.publishedAt ? (
              <Button
                variant="danger-ghost"
                disabled={busy}
                className="sm:mr-auto"
                onClick={() => {
                  setOpen(false);
                  setDeleting(true);
                }}
              >
                Supprimer
              </Button>
            ) : null}
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </form>
      </Modal>
      <ConfirmDialog
        open={deleting}
        title="Supprimer cet avis ?"
        message="Il n'a jamais été publié : il disparaît de l'ERP, preuve d'accord comprise."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}

/**
 * Texte « Comment les avis sont recueillis et vérifiés » (L111-7-2, D111-17/18), publié avec les avis.
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
        <span className="font-semibold">Comment les avis sont recueillis et vérifiés</span>
        {draft ? <Badge tone="amber">Modèle à relire</Badge> : <Badge tone="green">Enregistré</Badge>}
      </summary>
      <form onSubmit={onSubmit} noValidate className="mt-3 space-y-4">
        <p className="text-sm text-[var(--muted)]">
          Texte obligatoire dès qu'un avis est publié (Code de la consommation, L111-7-2) : il est affiché avec les avis sur le site.
          {draft ? " Ce modèle n'est pas encore enregistré : le relire, l'ajuster puis l'enregistrer." : ""}
        </p>
        <Field label="Titre" error={errors.titre}>
          <Input value={form.titre} maxLength={120} onChange={(e) => setForm({ ...form, titre: e.target.value })} />
        </Field>
        <Field label="Texte" error={errors.texte}>
          <Textarea rows={10} value={form.texte} onChange={(e) => setForm({ ...form, texte: e.target.value })} />
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
