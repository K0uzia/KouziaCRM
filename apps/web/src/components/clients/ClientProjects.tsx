import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card } from "@/components/ui/Card";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type StepStatus = "done" | "current" | "todo";

type ProjectForm = {
  name: string;
  progress: number;
  steps: Array<{ label: string; status: StepStatus; date: string | null; triggersDeposit2?: boolean }>;
  links: Array<{ label: string; url: string }>;
  checklist: Array<{ label: string; done: boolean; note: string | null }>;
  visibleOnPortal: boolean;
  status: ProjectStatus;
  kind: ProjectKind | null;
};

type ProjectKind = "SITE" | "LOGICIEL" | "MAINTENANCE" | "AUTRE";

/** Type affiché dans l'espace client (fiche du projet). */
const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  SITE: "Site web",
  LOGICIEL: "Logiciel",
  MAINTENANCE: "Maintenance et suivi",
  AUTRE: "Autre",
};

type ProjectStatus = "PLANNED" | "ACTIVE" | "DONE";

const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: "amber" | "teal" | "green" }> = {
  PLANNED: { label: "Planifié (acompte en attente)", tone: "amber" },
  ACTIVE: { label: "En cours", tone: "teal" },
  DONE: { label: "Terminé", tone: "green" },
};

type Project = ProjectForm & {
  id: string;
  quoteId: string | null;
  startedAt: string | null;
  /** Invitation à laisser un avis envoyée au passage à « Terminé » (une fois par projet). */
  reviewInviteSentAt: string | null;
  /** Devis d'origine accepté en 3 fois : étape du 2e acompte (verrouillée une fois exigible). */
  deposit2: { locked: boolean; missingStep: boolean } | null;
  /** Particulier sans demande d'exécution anticipée : démarrage au plus tôt (délai de rétractation). */
  startsNotBefore?: string | null;
};

const STEP_LABEL: Record<StepStatus, string> = {
  done: "Terminé",
  current: "En cours",
  todo: "À venir",
};

const EMPTY_FORM: ProjectForm = {
  name: "",
  progress: 0,
  steps: [],
  links: [],
  checklist: [],
  visibleOnPortal: true,
  status: "ACTIVE",
  kind: null,
};

/** Retire les lignes vides avant l'envoi : une ligne ajoutée puis laissée vide n'est pas une erreur. */
function cleanForm(f: ProjectForm): ProjectForm {
  return {
    ...f,
    name: f.name.trim(),
    steps: f.steps.filter((s) => s.label.trim()).map((s) => ({ ...s, date: s.date || null })),
    links: f.links.filter((l) => l.label.trim() || l.url.trim()),
    checklist: f.checklist
      .filter((c) => c.label.trim())
      .map((c) => ({ ...c, note: c.note?.trim() || null })),
  };
}

function progressFromSteps(steps: ProjectForm["steps"]): number {
  const filled = steps.filter((s) => s.label.trim());
  if (filled.length === 0) return 0;
  return Math.round((filled.filter((s) => s.status === "done").length / filled.length) * 100);
}

/** Avancement des projets du client, publié dans l'espace client (/suivi). */
export function ClientProjects({ clientId }: { clientId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; form: ProjectForm } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setProjects(await api<Project[]>(`/api/clients/${clientId}/projects`));
  }, [clientId]);

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, [load]);

  // Arrivée depuis le paiement de l'acompte (?projet=id) : la fiche du projet créé s'ouvre à compléter.
  const [params, setParams] = useSearchParams();
  const [fromPayment, setFromPayment] = useState(false);
  useEffect(() => {
    const wanted = params.get("projet");
    if (!wanted || projects.length === 0) return;
    const p = projects.find((x) => x.id === wanted);
    if (p) {
      setEditing({ id: p.id, form: { ...EMPTY_FORM, ...p } });
      setFromPayment(true);
    }
    const next = new URLSearchParams(params);
    next.delete("projet");
    setParams(next, { replace: true });
  }, [params, projects, setParams]);

  function update(patch: Partial<ProjectForm>) {
    setEditing((cur) => (cur ? { ...cur, form: { ...cur.form, ...patch } } : cur));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      const body = JSON.stringify(cleanForm(editing.form));
      let message = "Projet enregistré";
      if (editing.id) {
        const before = projects.find((p) => p.id === editing.id);
        const saved = await api<Project>(`/api/projects/${editing.id}`, { method: "PUT", body });
        if (saved.reviewInviteSentAt && !before?.reviewInviteSentAt) {
          message = "Projet enregistré. Invitation à laisser un avis envoyée au client.";
        }
      } else {
        await api(`/api/clients/${clientId}/projects`, { method: "POST", body });
      }
      toast.success(message);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/projects/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const form = editing?.form;
  const editingDeposit2 = editing?.id ? (projects.find((x) => x.id === editing.id)?.deposit2 ?? null) : null;

  return (
    <Card className="space-y-3 p-5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Projets</h2>
        <Button
          variant="secondary"
          className="px-3 text-xs"
          onClick={() => setEditing({ id: null, form: EMPTY_FORM })}
        >
          <FontAwesomeIcon icon={faPlus} className="h-3 w-3" aria-hidden />
          Nouveau projet
        </Button>
      </div>

      {projects.length === 0 ? (
        <p className="text-[var(--muted)]">
          Aucun projet. Un projet visible apparaît dans l&apos;espace client, bloc « Avancement ».
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {projects.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{p.name}</p>
                  <Badge tone={PROJECT_STATUS[p.status]?.tone ?? "neutral"}>{PROJECT_STATUS[p.status]?.label ?? p.status}</Badge>
                  {!p.visibleOnPortal ? <Badge tone="neutral">Masqué</Badge> : null}
                  {p.deposit2?.missingStep ? <Badge tone="amber">Étape du 2e acompte à choisir</Badge> : null}
                  {p.startsNotBefore ? (
                    <Badge tone="amber">Démarrage au plus tôt le {formatDate(p.startsNotBefore)}</Badge>
                  ) : null}
                  {p.quoteId ? (
                    <Link to={`/quotes/${p.quoteId}`} className="link text-xs">
                      Devis d'origine
                    </Link>
                  ) : null}
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--bg)]">
                  <div
                    className="h-full rounded-full bg-[var(--primary)]"
                    style={{ width: `${p.progress}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {p.progress} % · {p.steps.length} étape{p.steps.length > 1 ? "s" : ""} ·{" "}
                  {p.checklist.filter((c) => c.done).length}/{p.checklist.length} check-list
                  {p.reviewInviteSentAt ? ` · avis demandé le ${formatDate(p.reviewInviteSentAt)}` : ""}
                </p>
              </div>
              <Button
                variant="secondary"
                className="px-3 text-xs"
                onClick={() => setEditing({ id: p.id, form: { ...EMPTY_FORM, ...p } })}
              >
                Modifier
              </Button>
              <Button
                variant="ghost"
                className="px-2 text-xs"
                aria-label={`Supprimer ${p.name}`}
                onClick={() => setDeleting(p)}
              >
                <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => {
          if (busy) return;
          setEditing(null);
          setFromPayment(false);
        }}
        title={fromPayment ? "Projet créé : complétez-le" : editing?.id ? "Modifier le projet" : "Nouveau projet"}
        description={
          fromPayment
            ? "L'acompte est payé, le projet a démarré. Ajustez son nom, ses étapes, les liens et la check-list : le client les voit dans son espace."
            : undefined
        }
        wide
      >
        {form ? (
          <form onSubmit={save} className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="Nom du projet">
                <Input
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder="Site vitrine"
                />
              </Field>
              <Field label="Avancement (%)">
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    className="w-24"
                    value={form.progress}
                    onChange={(e) =>
                      update({ progress: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })
                    }
                  />
                  <Button
                    variant="ghost"
                    className="px-2 text-xs"
                    disabled={form.steps.length === 0}
                    onClick={() => update({ progress: progressFromSteps(form.steps) })}
                  >
                    Selon les étapes
                  </Button>
                </div>
              </Field>
            </div>
            <Field label="Type de projet" hint="Affiché au client dans son espace. Facultatif.">
              <Select value={form.kind ?? ""} onChange={(e) => update({ kind: (e.target.value || null) as ProjectKind | null })}>
                <option value="">Non précisé</option>
                {(Object.keys(PROJECT_KIND_LABEL) as ProjectKind[]).map((k) => (
                  <option key={k} value={k}>
                    {PROJECT_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Statut" hint="Planifié : acompte facturé, en attente de paiement. Il passe en cours au paiement. Terminé : projet livré, avancement à 100 %.">
              <Select
                value={form.status}
                onChange={(e) => {
                  const status = e.target.value as ProjectStatus;
                  // Terminé = livré : jauge à 100 % (le serveur applique la même règle).
                  update(status === "DONE" ? { status, progress: 100 } : { status });
                }}
              >
                <option value="PLANNED">Planifié</option>
                <option value="ACTIVE">En cours</option>
                <option value="DONE">Terminé</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.visibleOnPortal}
                onChange={(e) => update({ visibleOnPortal: e.target.checked })}
              />
              Visible dans l&apos;espace client
            </label>

            {editingDeposit2 ? (
              <p role="status" className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--muted)]">
                {editingDeposit2.locked
                  ? "Le 2e acompte est exigible : l'étape qui l'a déclenché ne peut plus changer."
                  : "Devis accepté en 3 fois : cochez l'étape qui, une fois terminée, rend le 2e acompte exigible."}
              </p>
            ) : null}
            <ListSection
              title="Étapes"
              onAdd={() =>
                update({ steps: [...form.steps, { label: "", status: "todo", date: null }] })
              }
            >
              {form.steps.map((s, i) => (
                <ListRow
                  key={i}
                  removeDisabled={Boolean(editingDeposit2?.locked && s.triggersDeposit2)}
                  onRemove={() => update({ steps: form.steps.filter((_, j) => j !== i) })}
                >
                  <Input
                    aria-label="Libellé de l'étape"
                    placeholder="Maquettes"
                    maxLength={120}
                    value={s.label}
                    onChange={(e) =>
                      update({
                        steps: form.steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      })
                    }
                  />
                  <Select
                    aria-label="Statut de l'étape"
                    className="sm:w-36"
                    value={s.status}
                    onChange={(e) =>
                      update({
                        steps: form.steps.map((x, j) =>
                          j === i ? { ...x, status: e.target.value as StepStatus } : x,
                        ),
                      })
                    }
                  >
                    {(Object.keys(STEP_LABEL) as StepStatus[]).map((k) => (
                      <option key={k} value={k}>
                        {STEP_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="date"
                    aria-label="Date de l'étape (facultative)"
                    className="sm:w-40"
                    value={s.date ?? ""}
                    onChange={(e) =>
                      update({
                        steps: form.steps.map((x, j) =>
                          j === i ? { ...x, date: e.target.value || null } : x,
                        ),
                      })
                    }
                  />
                  {editingDeposit2 ? (
                    <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(s.triggersDeposit2)}
                        disabled={editingDeposit2.locked}
                        onChange={(e) =>
                          // Une seule étape déclenche le 2e acompte : cocher l'une décoche les autres.
                          update({
                            steps: form.steps.map((x, j) => ({
                              ...x,
                              triggersDeposit2: j === i ? e.target.checked : false,
                            })),
                          })
                        }
                      />
                      Déclenche le 2e acompte
                    </label>
                  ) : null}
                </ListRow>
              ))}
            </ListSection>

            <ListSection
              title="Liens utiles (https)"
              onAdd={() => update({ links: [...form.links, { label: "", url: "" }] })}
            >
              {form.links.map((l, i) => (
                <ListRow
                  key={i}
                  onRemove={() => update({ links: form.links.filter((_, j) => j !== i) })}
                >
                  <Input
                    aria-label="Libellé du lien"
                    placeholder="Voir la version de démonstration"
                    maxLength={120}
                    value={l.label}
                    onChange={(e) =>
                      update({
                        links: form.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      })
                    }
                  />
                  <Input
                    type="url"
                    aria-label="Adresse du lien"
                    placeholder="https://…"
                    pattern="https://.*"
                    value={l.url}
                    onChange={(e) =>
                      update({
                        links: form.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                      })
                    }
                  />
                </ListRow>
              ))}
            </ListSection>

            <ListSection
              title="Check-list"
              onAdd={() =>
                update({ checklist: [...form.checklist, { label: "", done: false, note: null }] })
              }
            >
              {form.checklist.map((c, i) => (
                <ListRow
                  key={i}
                  onRemove={() => update({ checklist: form.checklist.filter((_, j) => j !== i) })}
                >
                  <label className="flex min-h-11 items-center gap-2 text-sm sm:w-20">
                    <input
                      type="checkbox"
                      checked={c.done}
                      onChange={(e) =>
                        update({
                          checklist: form.checklist.map((x, j) =>
                            j === i ? { ...x, done: e.target.checked } : x,
                          ),
                        })
                      }
                    />
                    Fait
                  </label>
                  <Input
                    aria-label="Élément de la check-list"
                    placeholder="Nom de domaine réservé"
                    maxLength={160}
                    value={c.label}
                    onChange={(e) =>
                      update({
                        checklist: form.checklist.map((x, j) =>
                          j === i ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="Note (facultative)"
                    placeholder="Note (facultative)"
                    maxLength={240}
                    value={c.note ?? ""}
                    onChange={(e) =>
                      update({
                        checklist: form.checklist.map((x, j) =>
                          j === i ? { ...x, note: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </ListRow>
              ))}
            </ListSection>

            <ModalActions>
              <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busy}>
                Enregistrer
              </Button>
            </ModalActions>
          </form>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Supprimer le projet"
        message={`Le projet « ${deleting?.name ?? ""} » disparaîtra aussi de l'espace client.`}
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function ListSection({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <legend className="text-sm font-medium">{title}</legend>
        <Button variant="ghost" className="px-3 text-sm" onClick={onAdd}>
          <FontAwesomeIcon icon={faPlus} className="h-3 w-3" aria-hidden />
          Ajouter
        </Button>
      </div>
      {children}
    </fieldset>
  );
}

function ListRow({
  onRemove,
  removeDisabled = false,
  children,
}: {
  onRemove: () => void;
  removeDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-2 sm:flex-row sm:items-center">
      {children}
      <Button variant="ghost" className="px-2 text-xs" aria-label="Retirer" disabled={removeDisabled} onClick={onRemove}>
        <FontAwesomeIcon icon={faTrash} className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
