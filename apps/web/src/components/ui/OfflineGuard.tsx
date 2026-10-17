import { useId, type ReactNode } from "react";
import { useReadOnly } from "@/lib/offline/read-only";

/**
 * Corps d'une fiche hors ligne : un seul « disabled » coupe tous ses boutons et champs (les liens restent actifs),
 * l'explication est liée par aria-describedby et reprise en info-bulle. Les créations permises hors ligne (note de
 * rendez-vous, nouveau devis) restent en dehors.
 */
export function OfflineGuard({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { readOnly, reason } = useReadOnly();
  const id = useId();
  return (
    <fieldset
      disabled={readOnly}
      aria-describedby={readOnly ? id : undefined}
      title={readOnly ? (reason ?? undefined) : undefined}
      data-offline-guard={readOnly ? "" : undefined}
      className={`m-0 min-w-0 border-0 p-0 ${className}`}
    >
      {readOnly ? (
        <span id={id} className="sr-only">
          {reason}
        </span>
      ) : null}
      {children}
    </fieldset>
  );
}
