import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Card";
import { Combobox } from "@/components/ui/Combobox";
import { Field, Textarea } from "@/components/ui/Field";
import { catalogGroups, type CatalogService } from "@/lib/catalog-options";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/api";

/** Besoin d'un client : une prestation du catalogue, « traité » à une date (null = en attente). */
export type ServiceNeed = { serviceId: string; name: string; active: boolean; doneAt: string | null; createdAt?: string };
export type ClientNeeds = { services: ServiceNeed[]; details: string };

export const MAX_NEEDS = 50;
export const MAX_NEEDS_DETAILS = 5000;

/** Besoins en attente : case « traité » non cochée. */
export const pendingNeeds = (services: ServiceNeed[] | undefined) => (services ?? []).filter((n) => !n.doneAt);

/** Prestations actives du catalogue, proposées comme besoins (null : lecture en cours). */
export function useNeedsCatalog() {
  const [catalog, setCatalog] = useState<CatalogService[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<CatalogService[]>("/api/services?active=1")
      .then((rows) => live && setCatalog(rows))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return { catalog, error };
}

/**
 * Besoins éditables : prestations choisies dans le catalogue (case « traité » en option), et « Précisions » en texte
 * libre pour ce que le catalogue ne dit pas (pages, délais, budget). catalog null : catalogue en cours de lecture.
 */
export function ServiceNeedsEditor({
  value,
  onChange,
  catalog,
  catalogError = null,
  showDone = false,
  disabled = false,
}: {
  value: ClientNeeds;
  onChange: (next: ClientNeeds) => void;
  catalog: CatalogService[] | null;
  catalogError?: string | null;
  showDone?: boolean;
  disabled?: boolean;
}) {
  const chosen = new Set(value.services.map((n) => n.serviceId));
  const offer = (catalog ?? []).filter((s) => !chosen.has(s.id));
  const full = value.services.length >= MAX_NEEDS;
  const placeholder = catalogError
    ? "Catalogue indisponible"
    : catalog === null
      ? "Lecture du catalogue…"
      : full
        ? `${MAX_NEEDS} besoins au plus`
        : catalog.length === 0
          ? "Catalogue vide : ajoutez des prestations dans Offre"
          : "Ajouter une prestation";

  const setServices = (services: ServiceNeed[]) => onChange({ ...value, services });

  return (
    <div className="space-y-3">
      <Combobox
        variant="action"
        label="Prestation souhaitée"
        placeholder={placeholder}
        searchPlaceholder="Prestation, pack ou abonnement"
        emptyText="Aucune prestation ne correspond."
        groups={catalogGroups(offer)}
        disabled={disabled || full || offer.length === 0}
        onChange={(serviceId, option) =>
          setServices([...value.services, { serviceId, name: option.label, active: true, doneAt: null }])
        }
      />
      {value.services.length > 0 ? (
        <ul className="space-y-1" aria-label="Prestations souhaitées">
          {value.services.map((need) => (
            <li key={need.serviceId} className="flex min-w-0 items-center gap-1">
              {showDone ? (
                <label className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={need.doneAt !== null}
                    disabled={disabled}
                    aria-label={`Traité : ${need.name}`}
                    onChange={(e) =>
                      setServices(
                        value.services.map((n) =>
                          n.serviceId === need.serviceId ? { ...n, doneAt: e.target.checked ? new Date().toISOString() : null } : n,
                        ),
                      )
                    }
                  />
                </label>
              ) : null}
              <span className="min-w-0 flex-1 py-2 text-sm">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`break-words ${need.doneAt ? "text-[var(--muted)] line-through" : ""}`}>{need.name}</span>
                  {need.active ? null : <Badge>archivée</Badge>}
                </span>
                {need.doneAt ? <span className="block text-xs text-[var(--muted)]">Traité le {formatDate(need.doneAt)}</span> : null}
              </span>
              <Button
                variant="danger-ghost"
                className="shrink-0 px-0"
                disabled={disabled}
                aria-label={`Retirer : ${need.name}`}
                onClick={() => setServices(value.services.filter((n) => n.serviceId !== need.serviceId))}
              >
                <FontAwesomeIcon icon={faXmark} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Field label="Précisions" hint="Ce que le catalogue ne dit pas : pages, contenus, délais, budget.">
        <Textarea
          value={value.details}
          rows={4}
          maxLength={MAX_NEEDS_DETAILS}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, details: e.target.value })}
        />
      </Field>
    </div>
  );
}
