import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

type AcceptanceProof = {
  id: string;
  signerName: string;
  source: string;
  userEmail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  pdfSha256: string | null;
  pdfPath: string | null;
  createdAt: string;
  /** null : signature antérieure au suivi des CGV et du délai de rétractation. */
  cgvAccepted: boolean | null;
  cgvUrl: string | null;
  cgvVersion: string | null;
  consumer: boolean | null;
  expressExecution: boolean | null;
  withdrawalEndsAt: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  PORTAL: "espace client",
  THREAD: "réponse par e-mail",
  ADMIN: "administration",
};

/** Preuves de signature d'un devis : horodatage, IP, navigateur, empreinte et PDF archivé. */
export function AcceptanceProofs({ quoteId }: { quoteId: string }) {
  const [proofs, setProofs] = useState<AcceptanceProof[]>([]);

  useEffect(() => {
    api<AcceptanceProof[]>(`/api/quotes/${quoteId}/acceptances`)
      .then(setProofs)
      .catch(() => setProofs([]));
  }, [quoteId]);

  if (proofs.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-3 text-xs">
      <p className="font-medium text-[var(--text)]">Preuve de signature</p>
      {proofs.map((p) => (
        <div key={p.id} className="space-y-0.5 text-[var(--muted)]">
          <p>
            {new Date(p.createdAt).toLocaleString("fr-FR")} · {SOURCE_LABEL[p.source] ?? p.source}
            {p.userEmail ? ` (${p.userEmail})` : ""}
          </p>
          {p.cgvAccepted && p.cgvUrl ? (
            <p>
              CGV acceptées en ligne :{" "}
              <a href={p.cgvUrl} target="_blank" rel="noopener noreferrer" className="link underline! underline-offset-2">
                version du {p.cgvVersion}
              </a>
            </p>
          ) : p.cgvAccepted === false ? (
            <p>CGV non acceptées en ligne</p>
          ) : null}
          {p.consumer && p.withdrawalEndsAt ? (
            <p>
              Délai de rétractation jusqu&apos;au {formatDate(p.withdrawalEndsAt)} inclus ·{" "}
              {p.expressExecution ? "exécution anticipée demandée" : "démarrage au plus tôt le lendemain"}
            </p>
          ) : null}
          {p.ipAddress || p.userAgent || p.pdfSha256 ? (
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center hover:text-[var(--text)]">Détails techniques</summary>
              <div className="mt-1 space-y-0.5">
                {p.ipAddress ? <p>IP : {p.ipAddress}</p> : null}
                {p.userAgent ? <p className="break-all">Navigateur : {p.userAgent}</p> : null}
                {p.pdfSha256 ? (
                  <p className="break-all">
                    Empreinte du PDF signé :{" "}
                    <span className="font-mono">{p.pdfSha256}</span>
                    <span className="block">
                      Code unique du fichier archivé : en cas de litige, il prouve que le devis signé n&apos;a pas été modifié.
                    </span>
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
          {p.pdfPath ? (
            <a
              href={`/api/quotes/${quoteId}/acceptances/${p.id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="link inline-flex min-h-11 items-center"
            >
              PDF signé archivé
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
