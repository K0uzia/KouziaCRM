import { useCallback, useEffect, useRef, useState } from "react";
import { parseSirenOrSiret, sirenSiretErrorMessage } from "@kouzia/forms";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";

export type CompanyLookupValue = {
  siren: string;
  siret: string;
  companyName: string;
  apeCode: string;
  companyVerifiedAt: string | null;
  locked: boolean;
};

export type CompanyLookupProps = {
  value: CompanyLookupValue;
  onChange: (next: CompanyLookupValue) => void;
  onAddressPrefill?: (addr: {
    addressLine1: string;
    postalCode: string;
    city: string;
    addressCityCode: string;
  }) => void;
  errors?: Partial<Record<"siren" | "siret" | "companyName", string>>;
  disabled?: boolean;
  lookupPath?: (siren: string) => string;
};

type LookupResponse = {
  siren: string;
  siret: string | null;
  legalName: string | null;
  tradeName: string | null;
  apeCode: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  citycode: string | null;
  legalForm: string | null;
  redacted: boolean;
  warnings: string[];
  verifiedAt?: string;
};

/**
 * Champ SIREN/SIRET avec lookup auto via recherche-entreprises.api.gouv.fr
 * (proxifié par l'API ERP). Se déclenche dès qu'un numéro Luhn-valide est complet.
 */
export function CompanyLookup({
  value,
  onChange,
  onAddressPrefill,
  errors,
  disabled,
  lookupPath = (siren) => `/api/entreprises/${siren}`,
}: CompanyLookupProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const lastLookedUp = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const patch = useCallback(
    (partial: Partial<CompanyLookupValue>) => {
      onChange({ ...valueRef.current, ...partial });
    },
    [onChange],
  );

  const runLookup = useCallback(
    async (raw: string) => {
      const parsed = parseSirenOrSiret(raw);
      if (parsed.kind === "invalid") {
        setInputError(sirenSiretErrorMessage(raw) ?? "SIREN/SIRET invalide");
        return;
      }
      const key = parsed.siret ?? parsed.siren!;
      if (lastLookedUp.current === key) return;

      setInputError(null);
      setBusy(true);
      setMessage(null);
      try {
        const data = await api<LookupResponse>(lookupPath(key));
        lastLookedUp.current = key;
        patch({
          siren: data.siren,
          siret: data.siret ?? parsed.siret ?? "",
          companyName:
            data.legalName?.trim() ||
            data.tradeName?.trim() ||
            valueRef.current.companyName,
          apeCode: data.apeCode ?? "",
          companyVerifiedAt: data.verifiedAt ?? new Date().toISOString(),
          locked: false,
        });
        // Même champs que Paramètres > Identité après import INPI
        if (data.postalCode || data.city || data.addressLine1) {
          onAddressPrefill?.({
            addressLine1: data.addressLine1 ?? "",
            postalCode: data.postalCode ?? "",
            city: data.city ?? "",
            addressCityCode: data.citycode ?? "",
          });
        }
        const foundBits = [
          data.apeCode ? `NAF ${data.apeCode}` : null,
          data.legalForm,
          data.city
            ? `${data.city}${data.postalCode ? ` (${data.postalCode})` : ""}`
            : null,
        ].filter(Boolean);
        if (data.redacted) {
          setMessage(
            [
              data.warnings?.[0] ??
                "Raison sociale et adresse non diffusées (open data).",
              foundBits.length ? `Récupéré : ${foundBits.join(" · ")}.` : null,
              "Complétez la raison sociale et l'adresse manuellement.",
            ]
              .filter(Boolean)
              .join(" "),
          );
        } else if (data.warnings?.length) {
          setMessage(data.warnings.join(" "));
        } else {
          setMessage(
            `Entreprise trouvée${data.legalForm ? ` (${data.legalForm})` : ""}. Vous pouvez modifier l'adresse de facturation.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Entreprise introuvable";
        setMessage(`${msg}. Vous pouvez saisir les informations manuellement.`);
        patch({
          siren: parsed.siren ?? "",
          siret: parsed.siret ?? valueRef.current.siret,
          locked: false,
          companyVerifiedAt: null,
        });
      } finally {
        setBusy(false);
      }
    },
    [lookupPath, onAddressPrefill, patch],
  );

  useEffect(() => {
    if (disabled) return;
    const raw = value.siret || value.siren;
    const parsed = parseSirenOrSiret(raw);
    if (parsed.kind === "invalid") return;
    const key = parsed.siret ?? parsed.siren!;
    if (lastLookedUp.current === key) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const wait = parsed.kind === "siret" ? 150 : 800;
    debounceRef.current = setTimeout(() => {
      void runLookup(raw);
    }, wait);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value.siren, value.siret, disabled, runLookup]);

  return (
    <div className="space-y-4">
      <Field
        label="SIREN / SIRET"
        hint={
          busy
            ? "Recherche en cours…"
            : "9 ou 14 chiffres : infos récupérées automatiquement"
        }
        error={inputError ?? errors?.siren ?? errors?.siret}
      >
        <div className="flex items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            value={value.siret || value.siren}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 14);
              lastLookedUp.current = null;
              if (digits.length <= 9) {
                patch({ siren: digits, siret: "", locked: false, companyVerifiedAt: null });
              } else {
                patch({
                  siren: digits.slice(0, 9),
                  siret: digits,
                  locked: false,
                  companyVerifiedAt: null,
                });
              }
              setInputError(null);
            }}
            disabled={disabled}
            inputMode="numeric"
            autoComplete="off"
          />
          <Button
            type="button"
            className="shrink-0"
            disabled={disabled || busy}
            onClick={() => {
              lastLookedUp.current = null;
              void runLookup(value.siret || value.siren);
            }}
          >
            {busy ? "Recherche…" : "Vérifier"}
          </Button>
        </div>
      </Field>

      <Field label="Raison sociale" hint="Obligatoire" error={errors?.companyName}>
        <Input
          required
          value={value.companyName}
          onChange={(e) => patch({ companyName: e.target.value })}
          disabled={disabled}
          placeholder={busy ? "Récupération…" : "Raison sociale ou nom commercial"}
        />
      </Field>

      {value.apeCode ? (
        <p className="text-xs text-[var(--muted)]">Code NAF/APE : {value.apeCode}</p>
      ) : null}

      {message ? (
        <p className="text-xs text-[var(--muted)]" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
