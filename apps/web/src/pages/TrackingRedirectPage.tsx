import { useEffect } from "react";

const PUBLIC_SITE_URL =
  import.meta.env.VITE_PUBLIC_SITE_URL?.trim() || "https://kouzia.fr";

/** Ancienne route ERP : renvoie vers l'espace client sur kouzia.fr. */
export function TrackingRedirectPage() {
  useEffect(() => {
    const target = new URL(`${PUBLIC_SITE_URL.replace(/\/$/, "")}/suivi`);
    const incoming = new URLSearchParams(window.location.search);
    incoming.forEach((value, key) => {
      target.searchParams.set(key, value);
    });
    window.location.replace(target.href);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
      Redirection vers l&apos;espace client…
    </div>
  );
}
