import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { faDesktop, faMobileScreen } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Tabs, useTabParam } from "@/components/ui/Tabs";
import { useMediaQuery } from "@/lib/use-media-query";
import { fieldErrorsOf, type FieldErrors } from "./shared";

/**
 * Éditeurs de l'espace Site : enregistrement automatique du brouillon, état affiché, et mise en page en deux
 * colonnes (formulaire en onglets, aperçu de la carte de kouzia.com). La mise en ligne reste le bouton Publier.
 */

export type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

/** Refus avant l'envoi (champ obligatoire vide, format) : les champs sont signalés, réessayer tel quel ne sert à rien. */
export class IncompleteFieldsError extends Error {
  constructor() {
    super("champs à compléter");
  }
}

/**
 * Enregistre `value` après une pause de frappe (`delay` ms) ou à la sortie d'un champ (`flush`), un enregistrement à
 * la fois ; au départ de l'écran, ce qui reste est envoyé. `reset(v)` déclare `v` comme déjà enregistré (après
 * chargement). Rien n'est envoyé tant que `enabled` est faux (création : le bouton Créer reste explicite). `save`
 * rejette avec l'erreur de l'API ; à l'appelant d'en tirer les erreurs par champ. Retour par un seul toast (même
 * identifiant, remplacé à chaque enregistrement) : « Enregistré », ou l'erreur avec « Réessayer ».
 */
export function useAutosave<T>(value: T, save: (v: T) => Promise<void>, enabled: boolean, delay = 1500, keyOf: (v: T) => string = (v) => JSON.stringify(v)) {
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  const key = keyOf(value);
  const clean = useRef<string | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const latest = useRef({ value, key, save, enabled });
  latest.current = { value, key, save, enabled };
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const toastId = useId();

  const run = useCallback(async (): Promise<void> => {
    while (pending.current) await pending.current;
    const { value: v, key: k, save: s, enabled: on } = latest.current;
    if (!on || clean.current === null || k === clean.current) return;
    setState({ kind: "saving" });
    const p = s(v).then(
      () => {
        clean.current = k;
        setState(latest.current.key === k ? { kind: "saved", at: new Date() } : { kind: "dirty" });
        toast.success("Enregistré", { id: toastId, action: undefined });
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : "Enregistrement impossible";
        setState({ kind: "error", message });
        if (e instanceof IncompleteFieldsError) toast.error("Non enregistré : champs à compléter, voir les onglets signalés.", { id: toastId, action: undefined });
        else toast.error(`Non enregistré : ${message}`, { id: toastId, action: { label: "Réessayer", onClick: () => void run() } });
      },
    );
    pending.current = p.finally(() => {
      pending.current = null;
    });
    await pending.current;
  }, [toastId]);

  useEffect(() => {
    if (!enabled || clean.current === null) return;
    if (key === clean.current) {
      // Retour à la version enregistrée (frappe annulée, erreur corrigée) : plus rien à envoyer.
      setState((s) => (s.kind === "dirty" || s.kind === "error" ? { kind: "idle" } : s));
      return;
    }
    setState((s) => (s.kind === "saving" ? s : { kind: "dirty" }));
    const t = setTimeout(() => void run(), delay);
    return () => clearTimeout(t);
  }, [key, enabled, delay, run]);

  // Départ de l'écran (lien, retour) : ce qui n'est pas encore enregistré part tout de suite.
  useEffect(
    () => () => {
      const { value: v, key: k, save: s, enabled: on } = latest.current;
      if (!on || clean.current === null || k === clean.current) return;
      s(v).catch((e: unknown) => toast.error(`Dernières modifications non enregistrées : ${e instanceof Error ? e.message : "erreur"}`));
    },
    [],
  );

  const dirty = enabled && clean.current !== null && key !== clean.current;
  useLeaveGuard(dirty || state.kind === "saving");

  const reset = useCallback((v: T) => {
    clean.current = keyOfRef.current(v);
    setState({ kind: "idle" });
  }, []);

  return { state, dirty, reset, flush: run };
}

/** Sortie d'un champ du formulaire : ce qui a changé part sans attendre la pause de frappe. */
export const flushOnFieldBlur = (flush: () => Promise<void>) => (e: FocusEvent<HTMLFormElement>) => {
  if (e.target instanceof HTMLElement && e.target.matches("input, textarea, select")) void flush();
};

/**
 * Fiche d'un élément d'une collection du site (réalisation, question, référence, témoignage) : chargement, formulaire,
 * erreurs par champ, enregistrement automatique, création explicite et suppression. `validate` reprend les règles de
 * l'API pour signaler un champ avant l'envoi ; `errorKey` ramène une erreur de l'API à son champ (ex. tech.2 → tech).
 */
export function useItemEditor<T extends { id: string }, F>({
  base,
  id,
  creating,
  empty,
  toForm,
  toBody,
  validate,
  errorKey = (k) => k.split(".")[0]!,
  itemPath,
  listPath,
  labels,
}: {
  base: string;
  id: string;
  creating: boolean;
  empty: F;
  toForm: (item: T) => F;
  toBody: (form: F, item: T | null) => unknown;
  validate: (form: F, item: T | null) => FieldErrors;
  errorKey?: (key: string) => string;
  itemPath: (item: T) => string;
  listPath: string;
  labels: { created: string; deleted: string; notFound: string };
}) {
  const navigate = useNavigate();
  const [item, setItem] = useState<T | null>(null);
  const [form, setForm] = useState<F>(empty);
  const [loading, setLoading] = useState(!creating);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const itemRef = useRef(item);
  itemRef.current = item;

  const apiErrors = useCallback(
    (err: unknown) => Object.fromEntries(Object.entries(fieldErrorsOf(err)).map(([k, v]) => [errorKey(k), v])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const save = useCallback(
    async (f: F) => {
      const local = validate(f, itemRef.current);
      setErrors(local);
      if (Object.keys(local).length) throw new IncompleteFieldsError();
      try {
        setItem(await api<T>(`${base}/${id}`, { method: "PUT", body: JSON.stringify(toBody(f, itemRef.current)) }));
      } catch (err) {
        setErrors(apiErrors(err));
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, id],
  );
  // Clé : le corps envoyé à l'API ; un état propre à l'écran (texte « proposé ») ne déclenche pas d'enregistrement.
  const auto = useAutosave(form, save, !creating && Boolean(item), undefined, (f) => JSON.stringify(toBody(f, itemRef.current)));

  const load = useCallback(async () => {
    if (creating) return;
    setLoading(true);
    try {
      const found = (await api<T[]>(base)).find((r) => r.id === id);
      if (!found) throw new Error(labels.notFound);
      const loaded = toForm(found);
      itemRef.current = found;
      setItem(found);
      setForm(loaded);
      auto.reset(loaded);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, id, creating]);
  useEffect(() => {
    void load();
  }, [load]);

  // Après un refus, les erreurs suivent la frappe : un champ corrigé n'est plus signalé.
  const hasErrors = Object.keys(errors).length > 0;
  useEffect(() => {
    if (hasErrors) setErrors(validate(form, itemRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, hasErrors]);

  const set = useCallback(<K extends keyof F>(key: K, value: F[K]) => setForm((f) => ({ ...f, [key]: value })), []);

  async function create(e: FormEvent) {
    e.preventDefault();
    const local = validate(form, null);
    setErrors(local);
    if (Object.keys(local).length) {
      toast.error("Champs à compléter : voir les onglets signalés.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<T>(base, { method: "POST", body: JSON.stringify(toBody(form, null)) });
      toast.success(labels.created);
      navigate(itemPath(created), { replace: true });
    } catch (err) {
      setErrors(apiErrors(err));
      toast.error(err instanceof Error ? err.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`${base}/${id}`, { method: "DELETE" });
      toast.success(labels.deleted);
      auto.reset(form);
      navigate(listPath, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
      setBusy(false);
      throw err;
    }
  }

  const onSubmit = (e: FormEvent) => {
    if (creating) return void create(e);
    e.preventDefault();
    void auto.flush();
  };
  const countErrors = (fields: readonly string[]) => fields.filter((f) => errors[f]).length;

  const onBlur = flushOnFieldBlur(auto.flush);
  return { item, setItem, form, setForm, set, loading, loadError, load, errors, setErrors, busy, setBusy, auto, onSubmit, onBlur, remove, countErrors };
}

/**
 * Document unique du site (coordonnées, offres, textes des pages) : brouillon de formulaire `D`, valeur publiée `V`
 * envoyée par PUT /api/site/texts/:key, enregistrement automatique et erreurs par chemin (formules.site.titre).
 */
export function useDocumentEditor<D, V>({
  textKey,
  initial,
  toValue,
  validate,
  onSaved,
}: {
  textKey: string;
  initial: D;
  toValue: (draft: D) => V;
  validate: (draft: D) => FieldErrors;
  onSaved: (value: V) => void;
}) {
  const [baseline] = useState(initial);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useCallback(
    async (draft: D) => {
      const local = validate(draft);
      setErrors(local);
      if (Object.keys(local).length) throw new IncompleteFieldsError();
      try {
        onSaved(await api<V>(`/api/site/texts/${textKey}`, { method: "PUT", body: JSON.stringify(toValue(draft)) }));
      } catch (e) {
        setErrors(fieldErrorsOf(e));
        throw e;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [textKey, onSaved],
  );
  const auto = useAutosave(form, save, true);
  const { reset } = auto;
  useEffect(() => reset(baseline), [reset, baseline]);
  // Après un refus, les erreurs suivent la frappe : un champ corrigé n'est plus signalé.
  const hasErrors = Object.keys(errors).length > 0;
  useEffect(() => {
    if (hasErrors) setErrors(validate(form));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, hasErrors]);
  const set = useCallback(<K extends keyof D>(key: K, value: D[K]) => setForm((f) => ({ ...f, [key]: value })), []);
  /** Nombre d'erreurs dont le chemin commence par l'un des préfixes (compte d'un onglet). */
  const count = (...prefixes: string[]) => Object.keys(errors).filter((k) => prefixes.some((p) => k === p || k.startsWith(`${p}.`))).length;
  /** Premier message d'erreur sous un chemin (listes : villes.2). */
  const errorFor = (prefix: string) => Object.entries(errors).find(([k]) => k === prefix || k.startsWith(`${prefix}.`))?.[1];
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void auto.flush();
  };
  const onBlur = flushOnFieldBlur(auto.flush);
  return { form, setForm, set, errors, errorFor, count, auto, onSubmit, onBlur };
}

/** Bas de fiche : état de l'enregistrement, puis « Créer » (création) ou « Enregistrer maintenant ». */
export function EditorFooter({ auto, creating, busy, createLabel }: { auto: { state: SaveState; dirty: boolean }; creating: boolean; busy: boolean; createLabel: string }) {
  return (
    <>
      <SaveStatus state={auto.state} creating={creating} />
      {creating ? (
        <Button type="submit" disabled={busy}>
          {busy ? "Création…" : createLabel}
        </Button>
      ) : (
        <Button type="submit" variant="secondary" disabled={!auto.dirty && auto.state.kind !== "error"}>
          Enregistrer maintenant
        </Button>
      )}
    </>
  );
}

/** Alerte du navigateur avant de fermer ou recharger l'onglet tant que quelque chose n'est pas enregistré. */
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}

/** « 14 h 32 » : heure à la française, sans les secondes. */
const heure = (d: Date) => `${d.getHours()} h ${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * État de l'enregistrement. Seuls « Enregistré » et les erreurs sont annoncés au lecteur d'écran : « Modifications
 * non enregistrées » changerait à chaque frappe.
 */
export function SaveStatus({ state, creating = false }: { state: SaveState; creating?: boolean }) {
  const text =
    creating
      ? "Pas encore créé : rien n'est enregistré avant « Créer »"
      : state.kind === "saving"
        ? "Enregistrement…"
        : state.kind === "dirty"
          ? "Modifications non enregistrées"
          : state.kind === "saved"
            ? `Enregistré à ${heure(state.at)}`
            : state.kind === "error"
              ? `Non enregistré : ${state.message}`
              : "Enregistrement automatique";
  const announced = state.kind === "saved" || state.kind === "error" ? text : "";
  return (
    <p data-save-status className={`text-sm ${state.kind === "error" ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
      <span aria-hidden>{text}</span>
      <span className="sr-only" role="status">
        {announced}
      </span>
    </p>
  );
}

export type PreviewDevice = "desktop" | "phone";
export type EditorTab<T extends string> = { id: T; label: string; content: ReactNode; errors?: number };

/**
 * Fiche d'un élément du site : formulaire en onglets (reflétés dans ?tab=) et aperçu de la carte de kouzia.com.
 * À partir de 1024 px, l'aperçu est une colonne à droite qui reste visible ; en dessous, un onglet « Aperçu ».
 */
export function EditorLayout<T extends string>({
  tabs,
  preview,
  footer,
  label,
  previewTitle = "Aperçu sur kouzia.com",
}: {
  tabs: ReadonlyArray<EditorTab<T>>;
  preview: (device: PreviewDevice) => ReactNode;
  /** Bas du formulaire, visible sur chaque onglet : état de l'enregistrement et boutons. */
  footer: ReactNode;
  /** Nom accessible de la bande d'onglets (ex. « Sections de la réalisation »). */
  label: string;
  /** Titre de l'aperçu (ex. « Carte de la liste » pour une réalisation, dont la page projet se voit sur le site). */
  previewTitle?: string;
}) {
  const wide = useMediaQuery("(min-width: 64rem)");
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const ids = [...tabs.map((t) => t.id), "apercu"] as Array<T | "apercu">;
  const [tab, setTab] = useTabParam<T | "apercu">(ids, tabs[0]!.id);
  const current = wide && tab === "apercu" ? tabs[0]!.id : tab;
  const tabDefs = [
    ...tabs.map((t) => ({ id: t.id as T | "apercu", label: t.label, count: t.errors || null })),
    ...(wide ? [] : [{ id: "apercu" as const, label: "Aperçu", count: null }]),
  ];

  const previewBlock = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{previewTitle}</p>
        <Segmented
          label="Taille de l'aperçu"
          value={device}
          onChange={setDevice}
          options={[
            { id: "desktop", label: "Ordinateur", icon: faDesktop },
            { id: "phone", label: "Téléphone", icon: faMobileScreen },
          ]}
        />
      </div>
      <div className="flex justify-center overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] p-3 font-display sm:p-4">
        <div className={`w-full ${device === "phone" ? "max-w-[22.5rem]" : ""}`} aria-label="Aperçu de la carte" role="group">
          {preview(device)}
        </div>
      </div>
      <p className="text-xs text-[var(--muted)]">Mis à jour à la frappe. Le site ne change qu'avec « Publier ».</p>
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:items-start">
      <Card className="min-w-0 p-4 sm:p-6">
        <Tabs tabs={tabDefs} value={current} onChange={setTab} label={label}>
          <div className="pt-5">{current === "apercu" ? previewBlock : tabs.find((t) => t.id === current)?.content}</div>
        </Tabs>
        <div className="mt-6 flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center sm:justify-between">{footer}</div>
      </Card>
      {wide ? (
        // Colonne fixe au défilement, bornée à l'écran : un aperçu plus haut défile dans la colonne (focusable au clavier).
        <Card className="sticky top-[calc(var(--topbar-h)+1rem)] max-h-[calc(100dvh-var(--topbar-h)-2rem)] overflow-y-auto p-4" tabIndex={0} role="region" aria-label={previewTitle}>
          {previewBlock}
        </Card>
      ) : null}
    </div>
  );
}
