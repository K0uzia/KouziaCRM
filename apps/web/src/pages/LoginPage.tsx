import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(import.meta.env.DEV ? "admin@kouzia.com" : "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      toast.success("Connecté");
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de connexion");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <svg viewBox="0 0 32 32" className="h-12 w-12" aria-hidden>
            <rect width="32" height="32" rx="7" fill="var(--surface-raised)" />
            <path d="M10 7v18M10 17l9-10M13 14l7 11" stroke="var(--primary)" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
          <p className="mt-4 font-display text-xl font-semibold tracking-wide">
            Kouzia <span className="text-[var(--primary)]">ERP</span>
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">Gestion, facturation et suivi client</p>
        </div>

        <form onSubmit={onSubmit} className="ui-card space-y-5 p-6 sm:p-8">
          <h1 className="text-lg font-semibold">Connexion</h1>
          {import.meta.env.DEV ? (
            <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-xs text-[var(--muted)]">
              Dev : email prérempli. Mot de passe = <code className="font-mono">ADMIN_PASSWORD</code> dans{" "}
              <code className="font-mono">.env</code> (puis <code className="font-mono">npm run db:seed</code> si
              vous venez de le modifier).
            </p>
          ) : null}
          {error ? (
            <p
              id="login-error"
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
            >
              {error}
            </p>
          ) : null}
          <Field label="Email">
            <Input
              type="email"
              required
              autoComplete="username"
              value={email}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Mot de passe">
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Connexion…" : "Se connecter"}
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-[var(--muted)]">Accès réservé. Les connexions sont limitées en nombre.</p>
      </div>
    </main>
  );
}
