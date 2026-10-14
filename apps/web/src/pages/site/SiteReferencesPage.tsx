import { useState, type FormEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useCreateParam } from "@/lib/use-create-param";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { FilterChips } from "@/components/ui/FilterChips";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { slugify } from "./SiteProjectsPage";
import {
  dateToIso,
  fieldErrorsOf,
  ImageField,
  isoToDate,
  LoadState,
  OrderButtons,
  REFERENCE_TYPE_LABEL,
  saveOrder,
  SCOPE_LABEL,
  SiteImage,
  STATUS_OPTIONS,
  StatusBadge,
  useSiteCollection,
  type FieldErrors,
  type SiteAuthorizationScope,
  type SiteItemStatus,
  type SiteProject,
  type SiteReference,
  type SiteReferenceType,
} from "./shared";

const BASE = "/api/site/references";

const emptyForm = {
  slug: "",
  type: "CLIENT" as SiteReferenceType,
  name: "",
  logoPath: null as string | null,
  url: "",
  productSlug: "",
  testimonialText: "",
  testimonialAuthor: "",
  testimonialRole: "",
  authorizationAt: "",
  authorizationChannel: "",
  authorizationScope: "" as SiteAuthorizationScope | "",
  contact: "",
  status: "DRAFT" as SiteItemStatus,
};

type Filter = "all" | SiteReferenceType;

/** Ce que l'autorisation enregistrée ne couvre pas (même règle que l'API, affichée avant l'envoi). */
export function authorizationGap(r: {
  authorizationAt: string | null;
  authorizationScope: SiteAuthorizationScope | null | "";
  logoPath: string | null;
  testimonialText: string | null;
}): string | null {
  if (!r.authorizationAt || !r.authorizationScope) return "Autorisation manquante";
  if (r.logoPath && r.authorizationScope === "NAME") return "Logo non autorisé";
  if (r.testimonialText && r.authorizationScope !== "TESTIMONIAL") return "Témoignage non autorisé";
  return null;
}

export function SiteReferencesPage() {
  const { rows, setRows, loading, error, reload } = useSiteCollection<SiteReference>(BASE);
  const projects = useSiteCollection<SiteProject>("/api/site/projects");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<SiteReference | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function openForm(r: SiteReference | null) {
    setEditing(r);
    setErrors({});
    setSlugTouched(Boolean(r));
    setForm(
      r
        ? {
            slug: r.slug,
            type: r.type,
            name: r.name,
            logoPath: r.logoPath,
            url: r.url ?? "",
            productSlug: r.productSlug ?? "",
            testimonialText: r.testimonialText ?? "",
            testimonialAuthor: r.testimonialAuthor ?? "",
            testimonialRole: r.testimonialRole ?? "",
            authorizationAt: isoToDate(r.authorizationAt),
            authorizationChannel: r.authorizationChannel ?? "",
            authorizationScope: r.authorizationScope ?? "",
            contact: r.contact ?? "",
            status: r.status,
          }
        : emptyForm,
    );
    setOpen(true);
  }
  useCreateParam(() => openForm(null));

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const local: FieldErrors = {};
    if (form.type === "USER" && !form.productSlug) local.productSlug = "Produit obligatoire pour « Ils l'utilisent ».";
    const hasTestimonial = Boolean(form.testimonialText.trim() || form.testimonialAuthor.trim());
    if (hasTestimonial && !(form.testimonialText.trim() && form.testimonialAuthor.trim())) {
      local.testimonial = "Témoignage : texte et auteur sont tous deux nécessaires.";
    }
    if (form.status === "PUBLISHED") {
      const gap = authorizationGap({
        authorizationAt: form.authorizationAt || null,
        authorizationScope: form.authorizationScope,
        logoPath: form.logoPath,
        testimonialText: form.testimonialText.trim() || null,
      });
      if (gap) local.authorizationScope = `${gap} : impossible de mettre la référence sur le site.`;
    }
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }
    setBusy(true);
    setErrors({});
    const body = {
      slug: form.slug.trim(),
      type: form.type,
      name: form.name,
      logoPath: form.logoPath,
      url: form.url.trim() || null,
      productSlug: form.productSlug || null,
      testimonial: hasTestimonial
        ? { text: form.testimonialText, author: form.testimonialAuthor, role: form.testimonialRole.trim() || null }
        : null,
      authorizationAt: dateToIso(form.authorizationAt),
      authorizationChannel: form.authorizationChannel.trim() || null,
      authorizationScope: form.authorizationScope || null,
      contact: form.contact.trim() || null,
      status: form.status,
    };
    try {
      await api(editing ? `${BASE}/${editing.id}` : BASE, { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      toast.success(editing ? "Référence enregistrée" : "Référence ajoutée");
      setOpen(false);
      await reload();
    } catch (err) {
      const fields = fieldErrorsOf(err);
      setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.startsWith("testimonial") ? "testimonial" : k, v])));
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
      toast.success("Référence supprimée");
      setDeleting(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const visible = filter === "all" ? rows : rows.filter((r) => r.type === filter);
  const move = (id: string, dir: -1 | 1) => void saveOrder(BASE, rows, visible, id, dir, setRows, (r) => r.name);
  const productName = (slug: string | null) => projects.rows.find((p) => p.slug === slug)?.name ?? slug;

  const columns: DataColumn<SiteReference>[] = [
    {
      name: "Référence",
      grow: 3,
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-3 py-2">
          <SiteImage path={r.logoPath} alt="" className="h-10 w-16 shrink-0 rounded-[var(--radius-sm)] object-contain" />
          <div className="min-w-0">
            <button type="button" onClick={() => openForm(r)} className="block max-w-full truncate text-left font-medium hover:text-[var(--primary)]">
              {r.name}
            </button>
            <p className="truncate text-xs text-[var(--muted)]">
              {r.type === "USER" && r.productSlug ? `Utilise ${productName(r.productSlug)}` : r.testimonialText ? "Avec témoignage" : r.slug}
            </p>
          </div>
        </div>
      ),
    },
    { name: "Type", width: "8rem", cell: (r) => REFERENCE_TYPE_LABEL[r.type] },
    {
      name: "Autorisation",
      width: "12rem",
      cell: (r) => {
        const gap = authorizationGap(r);
        return gap ? <Badge tone={r.status === "PUBLISHED" ? "red" : "neutral"}>{gap}</Badge> : <span className="text-sm">{SCOPE_LABEL[r.authorizationScope!]}</span>;
      },
    },
    { name: "Statut", width: "9rem", cell: (r) => <StatusBadge row={r} /> },
    {
      name: "Ordre",
      width: "7rem",
      cell: (r, i) => <OrderButtons name={r.name} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(r.id, d)} />,
    },
  ];

  const count = (t: SiteReferenceType) => rows.filter((r) => r.type === t).length;

  return (
    <div>
      <PageHeader
        title="Références"
        subtitle="Clients, partenaires et utilisateurs cités sur kouzia.com. Nom, logo et témoignage ne paraissent qu'avec une autorisation écrite qui les couvre."
        actions={
          <Button onClick={() => openForm(null)}>
            <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />
            Nouvelle référence
          </Button>
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={visible}
            onRowClick={(r) => openForm(r)}
            countLabel={visible.length > 1 ? "références" : "référence"}
            emptyTitle="Aucune référence"
            emptyHint="Une référence n'est ajoutée qu'avec l'accord écrit de l'entreprise citée."
            toolbar={
              <FilterChips
                label="Filtrer les références"
                value={filter}
                onChange={setFilter}
                wrap
                options={[
                  { id: "all", label: "Toutes", count: rows.length },
                  { id: "CLIENT", label: "Clients", count: count("CLIENT") },
                  { id: "PARTNER", label: "Partenaires", count: count("PARTNER") },
                  { id: "USER", label: "Utilisateurs", count: count("USER") },
                ]}
              />
            }
            renderMobileCard={(r, i) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <button type="button" onClick={() => openForm(r)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left">
                  <SiteImage path={r.logoPath} alt="" className="h-10 w-14 shrink-0 rounded-[var(--radius-sm)] object-contain" />
                  <span className="min-w-0">
                    <span className="line-clamp-2 break-words font-medium">{r.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
                      <StatusBadge row={r} />
                      {REFERENCE_TYPE_LABEL[r.type]}
                    </span>
                  </span>
                </button>
                <OrderButtons name={r.name} first={i === 0} last={i === visible.length - 1} onMove={(d) => move(r.id, d)} />
              </div>
            )}
          />
        </Card>
      </LoadState>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? editing.name : "Nouvelle référence"} fullScreenMobile wide>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nom" error={errors.name}>
              <Input
                required
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
                }}
              />
            </Field>
            <Field label="Type" error={errors.type}>
              <Select value={form.type} onChange={(e) => set("type", e.target.value as SiteReferenceType)}>
                {(Object.keys(REFERENCE_TYPE_LABEL) as SiteReferenceType[]).map((t) => (
                  <option key={t} value={t}>
                    {REFERENCE_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Identifiant" hint="Minuscules, chiffres et tirets." error={errors.slug}>
            <Input
              required
              spellCheck={false}
              className="font-mono"
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set("slug", e.target.value);
              }}
            />
          </Field>
          {form.type === "USER" ? (
            <Field label="Produit utilisé" hint="Une des réalisations du site." error={errors.productSlug}>
              <Select value={form.productSlug} onChange={(e) => set("productSlug", e.target.value)}>
                <option value="">Choisir…</option>
                {projects.rows.map((p) => (
                  <option key={p.id} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Site de la référence (facultatif)" hint="https obligatoire." error={errors.url}>
            <Input type="url" inputMode="url" value={form.url} onChange={(e) => set("url", e.target.value)} />
          </Field>
          <ImageField label="Logo" kind="LOGO" optional value={form.logoPath} onChange={(p) => set("logoPath", p)} error={errors.logoPath} />

          <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
            <legend className="px-1 text-sm font-medium">Témoignage (facultatif)</legend>
            <Field label="Texte du témoignage" error={errors.testimonial}>
              <Textarea rows={3} value={form.testimonialText} onChange={(e) => set("testimonialText", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Auteur du témoignage">
                <Input value={form.testimonialAuthor} onChange={(e) => set("testimonialAuthor", e.target.value)} />
              </Field>
              <Field label="Fonction (facultatif)">
                <Input value={form.testimonialRole} onChange={(e) => set("testimonialRole", e.target.value)} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
            <legend className="px-1 text-sm font-medium">Autorisation écrite (jamais publiée)</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date de l'autorisation" error={errors.authorizationAt}>
                <Input type="date" value={form.authorizationAt} onChange={(e) => set("authorizationAt", e.target.value)} />
              </Field>
              <Field label="Canal" hint="E-mail, courrier, contrat…" error={errors.authorizationChannel}>
                <Input value={form.authorizationChannel} onChange={(e) => set("authorizationChannel", e.target.value)} />
              </Field>
            </div>
            <Field label="Ce qui est autorisé" error={errors.authorizationScope}>
              <Select
                value={form.authorizationScope}
                onChange={(e) => set("authorizationScope", e.target.value as SiteAuthorizationScope | "")}
              >
                <option value="">Non renseigné</option>
                {(Object.keys(SCOPE_LABEL) as SiteAuthorizationScope[]).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Contact (facultatif)" hint="Personne qui a autorisé. Chiffré dans l'ERP." error={errors.contact}>
              <Textarea rows={2} value={form.contact} onChange={(e) => set("contact", e.target.value)} />
            </Field>
          </fieldset>

          <Field label="Statut" error={errors.status}>
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
        title="Supprimer cette référence ?"
        message="Elle n'a jamais été publiée : elle disparaît de l'ERP, autorisation et contact compris."
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}
