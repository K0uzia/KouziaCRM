import { useEffect, useState } from "react";
import { api } from "@/lib/api";

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
          {p.ipAddress || p.userAgent || p.pdfSha256 ? (
            <details>
              <summary className="cursor-pointer hover:text-[var(--text)]">Détails techniques</summary>
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
              className="link"
            >
              PDF signé archivé
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
