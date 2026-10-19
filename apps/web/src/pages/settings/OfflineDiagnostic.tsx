import { useEffect, useState } from "react";
import { formatMailDateTime } from "@/lib/format";
import { configuredOfflineOrigin, offlineEnabled } from "@/lib/offline/config";
import { refusedText, useCopyJournal, type JournalEntry } from "@/lib/offline/journal";
import { OWN_BUILD } from "@/lib/version";

type WorkerState = "aux commandes" | "aux commandes, nouvelle version en attente" | "enregistré, pas encore aux commandes" | "absent" | "indisponible";

async function workerState(): Promise<WorkerState> {
  if (!("serviceWorker" in navigator)) return "indisponible";
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (!reg) return "absent";
  if (!navigator.serviceWorker.controller) return "enregistré, pas encore aux commandes";
  return reg.waiting ? "aux commandes, nouvelle version en attente" : "aux commandes";
}

const MODE: Record<NonNullable<JournalEntry["mode"]>, string> = { full: "complète", incremental: "mise à jour" };

function entryText(e: JournalEntry): string {
  const what = e.mode ? `Copie ${MODE[e.mode]}` : "Copie";
  const how = e.trigger === "manuel" ? ", lancée à la main" : "";
  const counts = e.outcome === "non lancée" ? "" : ` : ${e.copied} élément${e.copied > 1 ? "s" : ""} copié${e.copied > 1 ? "s" : ""}${refusedText(e.refused) ? `, ${refusedText(e.refused)}` : ""}, ${Math.max(1, Math.round(e.durationMs / 1000))} s`;
  return `${what}${how} ${e.outcome}${counts}.${e.detail ? ` ${e.detail}` : ""}`;
}

/**
 * Diagnostic du hors ligne pour cet appareil : ce qu'il faut regarder quand la copie ou son indicateur manquent
 * (adresse configurée, version de l'interface, service worker, dix dernières tentatives et leurs refus).
 */
export function OfflineDiagnostic() {
  const journal = useCopyJournal();
  const [worker, setWorker] = useState<WorkerState | null>(null);
  useEffect(() => {
    void workerState().then(setWorker);
  }, []);
  const configured = configuredOfflineOrigin();
  return (
    <details className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3" data-offline-diagnostic>
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">Diagnostic du hors ligne</summary>
      <dl className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-[var(--muted)]">Mode hors ligne sur cette adresse</dt>
          <dd>
            {offlineEnabled()
              ? "Actif"
              : configured
                ? `Inactif : configuré pour ${configured}, page ouverte sur ${window.location.origin}`
                : "Inactif : adresse du hors ligne non configurée sur le serveur (ADMIN_PUBLIC_ORIGIN)"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Version de l&apos;interface</dt>
          <dd className="break-all font-[var(--font-mono)] text-xs">{OWN_BUILD}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--muted)]">Service worker (écrans en cache)</dt>
          <dd>{worker ?? "…"}</dd>
        </div>
      </dl>
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Dernières tentatives de copie</h3>
      {journal.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--muted)]">Aucune tentative enregistrée sur cet appareil.</p>
      ) : (
        <ol className="mt-2 space-y-2 text-sm">
          {journal.map((e) => (
            <li key={`${e.at}-${e.outcome}`} className={e.outcome === "terminée" && !e.detail ? undefined : "text-[var(--warning)]"}>
              <span className="text-xs text-[var(--muted)]">{formatMailDateTime(new Date(e.at))}</span>
              <span className="block">{entryText(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
