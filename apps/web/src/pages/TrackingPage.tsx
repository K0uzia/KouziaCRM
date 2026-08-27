import { useState, type CSSProperties, type FormEvent } from "react";

type TrackingDoc = {
  id: string;
  number: string | null;
  documentType: string;
  status: string;
  quoteStatus?: string | null;
  issueDate: string | null;
  validUntil: string | null;
  dueDate: string | null;
  milestones?: Array<{
    label: string;
    percentBps: number;
    status: string;
    triggerText: string;
  }>;
};

type TrackingBrand = {
  tradeName: string;
  accentColor: string;
  logoUrl: string | null;
  contactUrl: string | null;
};

type TrackingResult = {
  clientFirstName: string;
  brand: TrackingBrand;
  documents: TrackingDoc[];
};

const shell: CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  padding: "48px 16px",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  background: "#f8fafc",
  color: "#0f172a",
};

/**
 * Page de suivi publique: isolée du design system admin (pas de Card/Button partagés).
 */
export function TrackingPage() {
  const [clientNumber, setClientNumber] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<TrackingResult | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/public/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNumber, accessCode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Accès refusé");
      }
      setData(body as TrackingResult);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const accent = data?.brand.accentColor || "#0f766e";

  return (
    <div style={shell}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        {data?.brand.logoUrl ? (
          <img
            src={data.brand.logoUrl}
            alt=""
            style={{ height: 40, marginBottom: 12, objectFit: "contain" }}
          />
        ) : (
          <p style={{ margin: 0, fontSize: 22, fontWeight: 600, color: accent }}>
            {data?.brand.tradeName || "Suivi de projet"}
          </p>
        )}
        <h1 style={{ margin: "8px 0 0", fontSize: 20, fontWeight: 600 }}>Suivi de projet</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14, color: "#64748b" }}>
          Identifiez-vous avec votre code de suivi et votre code d&apos;accès.
        </p>

        <form
          onSubmit={onSubmit}
          style={{
            marginTop: 28,
            padding: 20,
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
          }}
        >
          <label style={{ display: "block", fontSize: 13, fontWeight: 500 }}>
            Code de suivi
            <input
              required
              value={clientNumber}
              placeholder="CLI-0001"
              onChange={(e) => setClientNumber(e.target.value.toUpperCase())}
              style={{
                display: "block",
                width: "100%",
                marginTop: 6,
                marginBottom: 14,
                padding: "10px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500 }}>
            Code d&apos;accès
            <input
              required
              type="password"
              autoComplete="off"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                marginTop: 6,
                marginBottom: 14,
                padding: "10px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                fontSize: 14,
              }}
            />
          </label>
          {error ? (
            <p style={{ margin: "0 0 12px", fontSize: 13, color: "#dc2626" }}>{error}</p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            style={{
              width: "100%",
              padding: "10px 14px",
              border: "none",
              borderRadius: 6,
              background: accent,
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? "Vérification…" : "Accéder"}
          </button>
        </form>

        {data ? (
          <div style={{ marginTop: 28 }}>
            <p style={{ fontSize: 14 }}>
              Bonjour <strong>{data.clientFirstName}</strong>
            </p>
            {data.documents.length === 0 ? (
              <p style={{ fontSize: 14, color: "#64748b" }}>Aucun document disponible.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 0" }}>
                {data.documents.map((d) => (
                  <li
                    key={d.id}
                    style={{
                      marginBottom: 12,
                      padding: 16,
                      background: "#fff",
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                    }}
                  >
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>
                      {d.number ?? "Document"} · {d.documentType}
                    </p>
                    <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>
                      Statut {d.quoteStatus ?? d.status}
                    </p>
                    {d.milestones && d.milestones.length > 0 ? (
                      <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13 }}>
                        {d.milestones.map((m, i) => (
                          <li key={`${d.id}-${i}`}>
                            {m.label} ({Math.round(m.percentBps / 100)}%) : {m.status}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {data.brand.contactUrl ? (
              <p style={{ marginTop: 20, fontSize: 13 }}>
                <a href={data.brand.contactUrl} style={{ color: accent }}>
                  Contacter
                </a>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
