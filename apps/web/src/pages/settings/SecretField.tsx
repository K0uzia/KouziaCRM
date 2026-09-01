import { Field, Input } from "@/components/ui/Field";
import type { SecretMeta } from "./types";

export function SecretField({
  label,
  hint,
  value,
  onChange,
  secret,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  secret: SecretMeta;
}) {
  return (
    <Field
      label={label}
      hint={
        hint ??
        (secret.set
          ? `Enregistré : ${secret.hint ?? "••••••••"}. Laissez vide pour conserver.`
          : "Non renseigné")
      }
    >
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={secret.set ? "Modifier…" : ""}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
