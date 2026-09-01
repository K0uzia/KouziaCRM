import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  fetchCommunesByPostalCode,
  searchAdresses,
  validateAdresse,
  type AdresseSuggestion,
  type Commune,
} from "@kouzia/forms";
import { Field, Input, Select } from "@/components/ui/Field";

export type AddressValue = {
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  addressCityCode: string;
  addressLat: number | null;
  addressLon: number | null;
  /** Case cochée : l'utilisateur confirme une adresse non trouvée dans BAN */
  addressManualConfirmed: boolean;
};

export type AddressAutocompleteProps = {
  value: AddressValue;
  onChange: (next: AddressValue) => void;
  errors?: Partial<Record<keyof AddressValue, string>>;
  /** Appelé quand la validation à la soumission échoue (bloquant). */
  onValidationError?: (message: string | null) => void;
  disabled?: boolean;
};

const COUNTRIES = [
  { value: "FRANCE", label: "France" },
  { value: "BELGIQUE", label: "Belgique" },
  { value: "SUISSE", label: "Suisse" },
  { value: "LUXEMBOURG", label: "Luxembourg" },
  { value: "AUTRE", label: "Autre" },
] as const;

function isFrance(country: string): boolean {
  return country === "FRANCE";
}

/**
 * Bloc adresse avec autocomplétion BAN + résolution ville via code postal.
 * Dégrade en saisie manuelle si les APIs gov sont injoignables.
 */
export function AddressAutocomplete({
  value,
  onChange,
  errors,
  disabled,
}: AddressAutocompleteProps) {
  const listId = useId();
  const [communes, setCommunes] = useState<Commune[]>([]);
  const [suggestions, setSuggestions] = useState<AdresseSuggestion[]>([]);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = useCallback(
    (partial: Partial<AddressValue>) => {
      onChange({ ...value, ...partial });
    },
    [onChange, value],
  );

  // Code postal → communes
  useEffect(() => {
    if (!isFrance(value.country)) {
      setCommunes([]);
      return;
    }
    const cp = value.postalCode.replace(/\s/g, "");
    if (!/^\d{5}$/.test(cp)) {
      setCommunes([]);
      return;
    }
    const ac = new AbortController();
    (async () => {
      const { communes: list, unavailable } = await fetchCommunesByPostalCode(cp, {
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      if (unavailable) {
        setApiWarning("Service d'adresses temporairement indisponible : saisie manuelle.");
        return;
      }
      setApiWarning(null);
      setCommunes(list);
      if (list.length === 1 && !value.city) {
        patch({ city: list[0]!.nom, addressCityCode: list[0]!.code });
      }
    })().catch(() => {
      /* AbortError ignoré */
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on ne re-patch que si city vide
  }, [value.postalCode, value.country]);

  // Autocomplétion adresse
  useEffect(() => {
    if (!isFrance(value.country)) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const q = value.addressLine1.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      searchAdresses(q, {
        postcode: value.postalCode,
        signal: ac.signal,
      })
        .then(({ suggestions: list, unavailable }) => {
          if (ac.signal.aborted) return;
          if (unavailable) {
            setApiWarning("Service d'adresses temporairement indisponible : saisie manuelle.");
            setSuggestions([]);
            setOpen(false);
            return;
          }
          setApiWarning(null);
          setSuggestions(list);
          setOpen(list.length > 0);
          setHighlight(-1);
        })
        .catch(() => {
          /* AbortError */
        });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [value.addressLine1, value.postalCode, value.country]);

  function selectSuggestion(s: AdresseSuggestion) {
    patch({
      addressLine1: s.name,
      postalCode: s.postcode,
      city: s.city,
      addressCityCode: s.citycode,
      addressLat: s.lat,
      addressLon: s.lon,
      addressManualConfirmed: false,
    });
    setSuggestions([]);
    setOpen(false);
  }

  function onAddressKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[highlight]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const cityAsSelect = isFrance(value.country) && communes.length > 1;

  return (
    <div className="space-y-4 rounded-[var(--radius)] border border-[var(--border)] p-4">
      <p className="text-sm font-medium">Adresse de facturation</p>

      {apiWarning ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {apiWarning}
        </p>
      ) : null}

      <Field label="Adresse" error={errors?.addressLine1}>
        <div className="relative">
          <Input
            value={value.addressLine1}
            onChange={(e) =>
              patch({
                addressLine1: e.target.value,
                addressCityCode: "",
                addressLat: null,
                addressLon: null,
              })
            }
            onKeyDown={onAddressKeyDown}
            onBlur={() => {
              // Laisse le clic sur suggestion se produire
              setTimeout(() => setOpen(false), 150);
            }}
            disabled={disabled}
            autoComplete="street-address"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
          />
          {open && suggestions.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-lg"
            >
              {suggestions.map((s, i) => (
                <li key={`${s.label}-${i}`} role="option" aria-selected={i === highlight}>
                  <button
                    type="button"
                    className={`w-full px-3 py-2 text-left text-sm text-[var(--text)] ${
                      i === highlight
                        ? "bg-[var(--bg-subtle,var(--bg))] text-[var(--text)]"
                        : "hover:bg-[var(--bg-subtle,var(--bg))] hover:text-[var(--text)]"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(s);
                    }}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Field>

      <Field label="Complément" error={errors?.addressLine2}>
        <Input
          value={value.addressLine2}
          onChange={(e) => patch({ addressLine2: e.target.value })}
          disabled={disabled}
          autoComplete="address-line2"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Code postal" error={errors?.postalCode}>
          <Input
            value={value.postalCode}
            onChange={(e) =>
              patch({
                postalCode: e.target.value,
                addressCityCode: "",
                addressLat: null,
                addressLon: null,
              })
            }
            disabled={disabled}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={isFrance(value.country) ? 5 : 12}
          />
        </Field>
        <Field label="Ville" className="sm:col-span-2" error={errors?.city}>
          {cityAsSelect ? (
            <Select
              value={value.city}
              onChange={(e) => {
                const c = communes.find((x) => x.nom === e.target.value);
                patch({
                  city: e.target.value,
                  addressCityCode: c?.code ?? "",
                });
              }}
              disabled={disabled}
            >
              <option value="">Choisir une commune…</option>
              {communes.map((c) => (
                <option key={c.code} value={c.nom}>
                  {c.nom}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={value.city}
              onChange={(e) => patch({ city: e.target.value, addressCityCode: "" })}
              disabled={disabled}
              autoComplete="address-level2"
            />
          )}
        </Field>
      </div>

      <Field label="Pays" error={errors?.country}>
        <Select
          value={value.country}
          onChange={(e) => patch({ country: e.target.value })}
          disabled={disabled}
        >
          {COUNTRIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>

      {isFrance(value.country) ? (
        <label className="flex items-start gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            className="mt-1"
            checked={value.addressManualConfirmed}
            onChange={(e) => patch({ addressManualConfirmed: e.target.checked })}
            disabled={disabled}
          />
          <span>
            Je confirme que l&apos;adresse est correcte (DOM-TOM, construction récente, non
            trouvée dans l&apos;annuaire officiel).
          </span>
        </label>
      ) : null}
    </div>
  );
}

/**
 * Revalide l'adresse avant soumission. Retourne un message d'erreur ou null.
 * Normalise silencieusement si le score BAN est élevé.
 */
export async function revalidateAddressBeforeSubmit(
  value: AddressValue,
  onChange: (next: AddressValue) => void,
): Promise<string | null> {
  if (!isFrance(value.country)) return null;
  if (!value.addressLine1.trim() || !value.postalCode.trim() || !value.city.trim()) {
    return null;
  }
  // Déjà géocodée via suggestion
  if (value.addressLat != null && value.addressLon != null && value.addressCityCode) {
    return null;
  }
  if (value.addressManualConfirmed) return null;

  const result = await validateAdresse(value.addressLine1, value.postalCode, value.city);
  if (result.status === "unavailable") return null;
  if (result.status === "ok") {
    onChange({
      ...value,
      addressLine1: result.address.addressLine1,
      postalCode: result.address.postalCode,
      city: result.address.city,
      addressCityCode: result.address.citycode,
      addressLat: result.address.lat,
      addressLon: result.address.lon,
      addressManualConfirmed: false,
    });
    return null;
  }
  if (result.status === "ambiguous") {
    return "Adresse ambiguë : choisissez une suggestion ou confirmez la saisie manuelle.";
  }
  return "Adresse introuvable. Corrigez-la ou cochez « Je confirme que l'adresse est correcte ».";
}
