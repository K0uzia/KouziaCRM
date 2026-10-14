import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, formatDate } from "@/lib/api";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadState, type SiteIssue, type SiteState } from "./shared";

type TestResult = { repo: string; branch: string; headSha: string; expiresAt: string | null; expiration: "date" | "none" | "invalid" };

export function SiteConnectionPage() {
  const [state, setState] = useState<SiteState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [busy, setBusy] = useState<"save" | "remove" | "test" | "import" | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "import" | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [importIssues, setImportIssues] = useState<SiteIssue[] | null>(null);

  async function load() {
    try {
      setState(await api<SiteState>("/api/site/status"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function saveToken(e: FormEvent) {
    e.preventDefault();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token.trim())) {
      setTokenError("Jeton GitHub attendu : il commence par github_pat_.");
      return;
    }
    setBusy("save");
    setTokenError(undefined);
    try {
      await api("/api/site/github", { method: "PUT", body: JSON.stringify({ token: token.trim() }) });
      setToken("");
      setTest(null);
      toast.success("Jeton enregistré (chiffré). Lancer un test pour relever sa date d'expiration.");
      await load();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Enregistrement impossible");
    } finally {
      setBusy(null);
    }
  }

  async function removeToken() {
    setBusy("remove");
    try {
      await api("/api/site/github", { method: "PUT", body: JSON.stringify({ token: null }) });
      setTest(null);
      setConfirm(null);
      toast.success("Jeton supprimé");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Suppression impossible");
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("test");
    try {
      setTest(await api<TestResult>("/api/site/github/test", { method: "POST" }));
      toast.success("Connexion au dépôt réussie (lecture seule)");
      await load();
    } catch (err) {
      setTest(null);
      toast.error(err instanceof Error ? err.message : "Test impossible");
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    setBusy("import");
    try {
      const res = await api<{ issues: SiteIssue[] }>("/api/site/import", { method: "POST" });
      setImportIssues(res.issues);
      setConfirm(null);
      toast.success("Contenu du site repris dans l'ERP");
      await load();
    } catch (err) {
      setConfirm(null);
      toast.error(err instanceof Error ? err.message : "Reprise impossible");
    } finally {
      setBusy(null);
    }
  }

  const gh = state?.github;

  return (
    <div>
      <PageHeader
        title="Connexion au dépôt"
        subtitle="Le site kouzia.com est construit depuis un dépôt GitHub. L'ERP y lit le contenu et, plus tard, y publiera."
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        {state && gh ? (
          <div className="max-w-3xl space-y-4">
            <Card className="space-y-4 p-4 sm:p-6">
              <h2 className="text-base font-semibold">Jeton d'accès GitHub</h2>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-[var(--muted)]">Dépôt</dt>
                <dd className="break-all font-mono">
                  {gh.repo} ({gh.branch})
                </dd>
                <dt className="text-[var(--muted)]">Jeton</dt>
                <dd>
                  {gh.token.set ? (
                    <span className="font-mono">{gh.token.hint}</span>
                  ) : (
                    <Badge tone="amber">Aucun jeton</Badge>
                  )}
                </dd>
                <dt className="text-[var(--muted)]">Expiration</dt>
                <dd>
                  {!gh.token.set
                    ? "-"
                    : gh.expiresAt
                      ? formatDate(gh.expiresAt)
                      : gh.checkedAt
                        ? "Sans date d'expiration"
                        : "Pas encore vérifiée : lancer un test"}
                  {gh.token.set && gh.checkedAt ? (
                    <span className="block text-xs text-[var(--muted)]">Vérifiée le {formatDate(gh.checkedAt)}</span>
                  ) : null}
                </dd>
              </dl>
              <form onSubmit={saveToken} noValidate className="space-y-3 border-t border-[var(--border)] pt-4">
                <Field
                  label={gh.token.set ? "Remplacer le jeton" : "Nouveau jeton"}
                  hint="Jeton « fine-grained » limité au dépôt du site : Contents en lecture et écriture, Actions en lecture. Il est chiffré et n'est jamais réaffiché."
                  error={tokenError}
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy !== null || !token.trim()}>
                    {busy === "save" ? "Enregistrement…" : "Enregistrer le jeton"}
                  </Button>
                  {gh.token.set ? (
                    <>
                      <Button variant="secondary" disabled={busy !== null} onClick={() => void runTest()}>
                        {busy === "test" ? "Test…" : "Tester la connexion"}
                      </Button>
                      <Button variant="danger-ghost" disabled={busy !== null} onClick={() => setConfirm("remove")}>
                        Supprimer le jeton
                      </Button>
                    </>
                  ) : null}
                </div>
              </form>
              {test ? (
                <p className="rounded-[var(--radius-sm)] bg-[var(--success-soft)] p-3 text-sm" role="status">
                  Dépôt joint en lecture seule : {test.repo}, branche {test.branch} au commit{" "}
                  <span className="font-mono">{test.headSha.slice(0, 7)}</span>.
                  {test.expiration === "date" && test.expiresAt
                    ? ` Jeton valable jusqu'au ${formatDate(test.expiresAt)}.`
                    : test.expiration === "none"
                      ? " Jeton sans date d'expiration."
                      : " Date d'expiration illisible dans la réponse de GitHub : la vérifier sur github.com."}
                </p>
              ) : null}
            </Card>

            <Card className="space-y-3 p-4 sm:p-6">
              <h2 className="text-base font-semibold">Reprise du contenu actuel</h2>
              {state.empty ? (
                <>
                  <p className="text-sm text-[var(--muted)]">
                    Une seule fois, sur un espace Site vide : l'ERP lit les fichiers de contenu du dépôt (sans rien y écrire) et
                    les reprend tels quels, comme déjà publiés.
                  </p>
                  <Button disabled={busy !== null || !gh.token.set} onClick={() => setConfirm("import")}>
                    {busy === "import" ? "Reprise…" : "Reprendre le contenu du site"}
                  </Button>
                  {!gh.token.set ? <p className="text-xs text-[var(--muted)]">Enregistrer d'abord un jeton.</p> : null}
                </>
              ) : (
                <p className="text-sm text-[var(--muted)]">
                  L'espace Site contient déjà du contenu : la reprise n'est plus possible, le contenu se modifie dans l'ERP.
                </p>
              )}
              {importIssues ? (
                importIssues.length ? (
                  <div className="rounded-[var(--radius-sm)] bg-[var(--warning-soft)] p-3 text-sm" role="status">
                    <p className="font-medium">Contenu repris, avec {importIssues.length} point(s) à régler avant toute publication :</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {importIssues.map((i, n) => (
                        <li key={n}>{i.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="rounded-[var(--radius-sm)] bg-[var(--success-soft)] p-3 text-sm" role="status">
                    Contenu repris sans anomalie.
                  </p>
                )
              ) : null}
            </Card>
          </div>
        ) : null}
      </LoadState>
      <ConfirmDialog
        open={confirm === "remove"}
        title="Supprimer le jeton GitHub ?"
        message="L'ERP ne pourra plus lire ni publier le site tant qu'un nouveau jeton n'est pas enregistré. Pensez à le révoquer aussi sur GitHub."
        confirmLabel="Supprimer"
        danger
        busy={busy === "remove"}
        onConfirm={() => void removeToken()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "import"}
        title="Reprendre le contenu du site ?"
        message="Les six fichiers de contenu du dépôt sont lus et repris dans l'ERP. Rien n'est écrit dans le dépôt. Cette reprise ne se fait qu'une fois."
        confirmLabel="Reprendre"
        busy={busy === "import"}
        onConfirm={() => void runImport()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
