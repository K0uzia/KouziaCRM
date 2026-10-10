import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";

type Status = { enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number };
type Setup = { secret: string; otpauthUri: string; qrSvg: string };

/** Code à 6 chiffres saisi au clavier ou collé depuis l'application (espaces ignorés). */
function CodeInput({
  value,
  onChange,
  describedBy,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  return (
    <Input
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={7}
      required
      value={value}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      className="max-w-40 font-mono tracking-[0.3em]"
    />
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  function download() {
    const text = [
      "Kouzia ERP : codes de secours de la double authentification.",
      "Chaque code ne sert qu'une fois. Gardez-les hors de l'ordinateur (papier, coffre).",
      "",
      ...codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "kouzia-erp-codes-de-secours.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success("Codes copiés");
    } catch {
      toast.error("Copie impossible : notez-les à la main");
    }
  }

  return (
    <div className="space-y-4" role="status">
      <p className="text-sm">
        Voici vos <strong>codes de secours</strong>. Ils remplacent un code de l&apos;application si vous perdez le
        téléphone. Chacun ne sert qu&apos;une fois et ils ne seront <strong>plus jamais affichés</strong>.
      </p>
      <ol className="grid grid-cols-1 gap-2 font-mono text-sm min-[400px]:grid-cols-2">
        {codes.map((c) => (
          <li
            key={c}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-center"
          >
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={download}>
          Télécharger
        </Button>
        <Button variant="secondary" onClick={() => void copy()}>
          Copier
        </Button>
        <Button onClick={onDone}>J&apos;ai mis mes codes à l&apos;abri</Button>
      </div>
    </div>
  );
}

/** Réglages > Sécurité : activation de la double authentification (TOTP) et codes de secours. */
export function SecurityTab() {
  const errorId = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await api<Status>("/api/auth/2fa/status"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Chargement impossible");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api<Setup>("/api/auth/2fa/setup", { method: "POST" }));
      setCode("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent, path: "/api/auth/2fa/enable" | "/api/auth/2fa/recovery-codes") {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>(path, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setCodes(res.recoveryCodes);
      setSetup(null);
      setRegenerating(false);
      setCode("");
      toast.success(path.endsWith("enable") ? "Double authentification activée" : "Nouveaux codes de secours créés");
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Code incorrect.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <Card className="space-y-3 border border-[var(--border)] p-5">
        <p role="alert" className="text-sm text-[var(--danger)]">
          {loadError}
        </p>
        <Button variant="secondary" onClick={() => void load()}>
          Réessayer
        </Button>
      </Card>
    );
  }
  if (!status) return <p className="text-sm text-[var(--muted)]">Chargement…</p>;

  const errorBlock = error ? (
    <p id={errorId} role="alert" className="text-sm text-[var(--danger)]">
      {error}
    </p>
  ) : null;

  return (
    <Card className="space-y-5 border border-[var(--border)] p-5">
      <div>
        <h2 className="text-base font-semibold">Double authentification</h2>
        <p className="mt-1 max-w-xl text-xs text-[var(--muted)]">
          Après le mot de passe, un code à 6 chiffres de Google Authenticator (ou une application équivalente) est
          demandé. Obligatoire pour se connecter par Internet (erp.kouzia.com).
        </p>
      </div>

      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : status.enabled ? (
        <div className="space-y-4">
          <p className="text-sm">
            <strong className="text-[var(--success)]">Activée</strong>
            {status.enabledAt ? ` depuis le ${new Date(status.enabledAt).toLocaleDateString("fr-FR")}` : null}.{" "}
            {status.recoveryCodesRemaining} code{status.recoveryCodesRemaining > 1 ? "s" : ""} de secours restant
            {status.recoveryCodesRemaining > 1 ? "s" : ""}.
          </p>
          {status.recoveryCodesRemaining <= 3 ? (
            <p className="text-sm text-[var(--warning)]">Il reste peu de codes de secours : créez-en de nouveaux.</p>
          ) : null}
          {regenerating ? (
            <form onSubmit={(e) => void submit(e, "/api/auth/2fa/recovery-codes")} className="space-y-3">
              <Field label="Code de l'application" hint="Les anciens codes de secours cesseront de fonctionner.">
                <CodeInput value={code} onChange={setCode} invalid={!!error} describedBy={error ? errorId : undefined} />
              </Field>
              {errorBlock}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {busy ? "Vérification…" : "Créer de nouveaux codes"}
                </Button>
                <Button variant="ghost" onClick={() => setRegenerating(false)}>
                  Annuler
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setRegenerating(true)}>
              Nouveaux codes de secours
            </Button>
          )}
          <p className="text-xs text-[var(--muted)]">
            Téléphone et codes perdus : sur le serveur, <code className="font-mono">kouziactl 2fa-reset &lt;email&gt;</code>{" "}
            désactive la double authentification et ferme toutes les sessions.
          </p>
        </div>
      ) : setup ? (
        <form onSubmit={(e) => void submit(e, "/api/auth/2fa/enable")} className="space-y-4">
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              Dans Google Authenticator, ajoutez un compte en scannant ce QR code.
              <img
                src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`}
                alt="QR code d'enrôlement pour l'application d'authentification"
                width={192}
                height={192}
                className="mt-3 rounded-[var(--radius-sm)]"
              />
            </li>
            <li>
              Ou saisissez la clé à la main (type « basé sur l&apos;heure ») :
              <code className="mt-2 block break-all rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 font-mono text-sm">
                {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
            </li>
            <li>
              <Field label="Code affiché par l'application">
                <CodeInput value={code} onChange={setCode} invalid={!!error} describedBy={error ? errorId : undefined} />
              </Field>
            </li>
          </ol>
          {errorBlock}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Vérification…" : "Activer"}
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              Annuler
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            <strong className="text-[var(--warning)]">Désactivée.</strong> La connexion par Internet est refusée tant
            qu&apos;elle n&apos;est pas activée.
          </p>
          <Button onClick={() => void startSetup()} disabled={busy}>
            {busy ? "Préparation…" : "Activer la double authentification"}
          </Button>
        </div>
      )}
    </Card>
  );
}
