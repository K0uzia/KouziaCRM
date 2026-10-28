import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { ruleCounter, type SenderRule } from "@/pages/messaging/sender-rules";

type Action = "BLOCK" | "TRUST";
type Kind = "ADDRESS" | "DOMAIN";

const SECTIONS: Record<Action, { title: string; hint: string; empty: string }> = {
  BLOCK: {
    title: "Expéditeurs bloqués",
    hint: "Leurs messages vont dans Indésirables sur la boîte mail, sans notification. Un client n'est jamais bloqué.",
    empty: "Aucun expéditeur bloqué.",
  },
  TRUST: {
    title: "Expéditeurs de confiance",
    hint: "Jamais bloqués, images affichées d'office. Les clients le sont déjà.",
    empty: "Aucun expéditeur de confiance.",
  },
};

function RuleSection({
  action,
  rules,
  onChange,
}: {
  action: Action;
  rules: SenderRule[];
  onChange: () => void;
}) {
  const [kind, setKind] = useState<Kind>("ADDRESS");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const section = SECTIONS[action];

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/emails/sender-rules", { method: "POST", body: JSON.stringify({ kind, action, value }) });
      setValue("");
      toast.success(action === "BLOCK" ? "Expéditeur bloqué" : "Expéditeur ajouté aux expéditeurs de confiance");
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ajout impossible");
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: SenderRule) {
    try {
      await api(`/api/emails/sender-rules/${rule.id}`, { method: "DELETE" });
      toast.success(`${rule.value} retiré de la liste`);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retrait impossible");
    }
  }

  return (
    <section className="space-y-3" aria-labelledby={`regles-${action}`}>
      <div className="space-y-1">
        <h3 id={`regles-${action}`} className="text-sm font-semibold">
          {section.title}
        </h3>
        <p className="text-sm text-[var(--muted)]">{section.hint}</p>
      </div>
      {rules.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">{section.empty}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-[1_1_14rem]">
                <p className="break-all text-sm font-medium">
                  {r.kind === "DOMAIN" ? `Tout le domaine ${r.value}` : r.value}
                </p>
                <p className="text-xs text-[var(--muted)]">{ruleCounter(r, formatDate)}</p>
              </div>
              <Button variant="ghost" className="text-sm" aria-label={`Retirer ${r.value}`} onClick={() => void remove(r)}>
                Retirer
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void add(e)}>
        <Segmented
          label={`Type de règle : ${section.title.toLowerCase()}`}
          fieldHeight
          value={kind}
          onChange={setKind}
          options={[
            { id: "ADDRESS", label: "Adresse" },
            { id: "DOMAIN", label: "Domaine" },
          ]}
        />
        <Field
          label={kind === "ADDRESS" ? "Adresse e-mail" : "Domaine"}
          error={error ?? undefined}
          className="min-w-0 flex-[1_1_14rem]"
        >
          <Input
            value={value}
            inputMode="email"
            autoComplete="off"
            placeholder={kind === "ADDRESS" ? "nom@exemple.fr" : "exemple.fr"}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={busy || !value.trim()}>
          {busy ? "Ajout…" : "Ajouter"}
        </Button>
      </form>
    </section>
  );
}

/** Réglages, E-mail : expéditeurs bloqués et de confiance de la messagerie. */
export function MailSenderRulesCard() {
  const [rules, setRules] = useState<SenderRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<SenderRule[]>("/api/emails/sender-rules")
      .then((r) => !cancelled && setRules(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Liste indisponible"));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <Card className="space-y-5 border border-[var(--border)] p-5">
      <h2 className="text-base font-semibold">Expéditeurs bloqués et de confiance</h2>
      {error ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-[var(--danger)]">{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Réessayer
          </Button>
        </div>
      ) : !rules ? (
        <p className="text-sm text-[var(--muted)]" role="status">
          Chargement…
        </p>
      ) : (
        (["BLOCK", "TRUST"] as const).map((action) => (
          <RuleSection
            key={action}
            action={action}
            rules={rules.filter((r) => r.action === action)}
            onChange={() => setAttempt((n) => n + 1)}
          />
        ))
      )}
    </Card>
  );
}
