import { useEffect } from "react";
import { useParams } from "react-router-dom";

/**
 * Ancienne route ERP /onboarding/:token.
 * Redirige vers le formulaire public hébergé sur Kouzia.
 */
export function OnboardingPage() {
  const { token } = useParams<{ token: string }>();
  const site =
    (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.replace(/\/$/, "") ||
    "https://kouzia.fr";

  useEffect(() => {
    if (!token) return;
    const url = `${site}/nouveau-client?token=${encodeURIComponent(token)}`;
    window.location.replace(url);
  }, [token, site]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <p className="text-sm text-[var(--muted)]">Redirection vers le formulaire sécurisé…</p>
    </div>
  );
}
