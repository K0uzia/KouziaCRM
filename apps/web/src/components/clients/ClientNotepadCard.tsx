import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { api, isServerDown } from "@/lib/api";
import { errorMessage, isNetworkFailure, isOfflineError, useOnline } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import { enqueueNotepad, isLocalClientId, replayQueue, useOfflineQueue } from "@/lib/offline/queue";
import { useReadOnly } from "@/lib/offline/read-only";
import { Card } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { Textarea } from "@/components/ui/Field";
import { useUnsavedGuard } from "@/lib/unsaved";

type Notepad = { text: string; version: number; updatedAt: string | null; conflictAt: string | null; conflict?: boolean };
type Status = "idle" | "dirty" | "saving" | "saved" | "queued" | "error";

/** Délai après la dernière frappe avant l'enregistrement automatique. */
const AUTOSAVE_MS = 1200;
const MAX = 50_000;

const hhmm = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(" ", " à ");

/**
 * Bloc-notes unique de la fiche : un seul texte, enregistré tout seul (1,2 s après la dernière frappe, et en
 * quittant le champ). Hors ligne : une seule entrée de file par client, la dernière version gagne. Enregistré
 * ailleurs entre-temps : le serveur garde les deux textes et le bandeau « à relire » reste jusqu'au suivant.
 */
export function ClientNotepadCard({ clientId, clientName }: { clientId: string; clientName: string }) {
  const local = isLocalClientId(clientId);
  const online = useOnline();
  const { readOnly, canPrepare } = useReadOnly();
  const { items } = useOfflineQueue();
  const pending = items.find((i) => i.kind === "notepad" && i.clientId === clientId);
  const titleId = useId();
  const statusId = useId();

  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(local);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [conflictAt, setConflictAt] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Dernier état connu du serveur (version lue, texte) : la saisie s'enregistre par rapport à lui.
  const base = useRef<{ version: number; text: string }>({ version: 0, text: "" });
  const textRef = useRef("");
  const inFlight = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const apply = useCallback((n: Notepad) => {
    base.current = { version: n.version, text: n.text };
    setConflictAt(n.conflictAt);
    setSavedAt(n.updatedAt);
  }, []);

  // Lecture à l'ouverture, au retour du réseau et quand l'entrée de file de ce client vient de partir. Une saisie
  // en cours n'est jamais écrasée par une relecture.
  const pendingText = typeof pending?.body.text === "string" ? pending.body.text : null;
  useEffect(() => {
    if (local) {
      if (pendingText !== null && textRef.current === "") {
        textRef.current = pendingText;
        setText(pendingText);
      }
      return;
    }
    let alive = true;
    api<Notepad>(`/api/clients/${encodeURIComponent(clientId)}/notepad`)
      .then((n) => {
        if (!alive) return;
        const untouched = textRef.current === base.current.text;
        apply(n);
        if (untouched) {
          const shown = pendingText ?? n.text;
          textRef.current = shown;
          setText(shown);
        }
        setLoaded(true);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (pendingText !== null) {
          textRef.current = pendingText;
          setText(pendingText);
          setLoaded(true);
          return;
        }
        setLoadError(
          isNetworkFailure(e) ? "Non disponible hors ligne : ce bloc-notes n'est pas encore sur l'appareil." : errorMessage(e, "Bloc-notes non chargé."),
        );
      });
    return () => {
      alive = false;
    };
    // pendingText suit la file : relu quand l'entrée part (elle disparaît) ou change.
  }, [clientId, local, online, pending === undefined, apply]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const sending = textRef.current;
    if (sending === base.current.text && !pending) {
      setStatus((s) => (s === "dirty" ? "saved" : s));
      return;
    }
    inFlight.current = true;
    setStatus("saving");
    const toQueue = async () => {
      await enqueueNotepad({ clientId, clientName, text: sending, baseVersion: base.current.version });
      base.current = { ...base.current, text: sending };
      setStatus("queued");
      if (online) void replayQueue();
    };
    try {
      if (offlineEnabled() && (!online || local)) {
        await toQueue();
      } else {
        const saved = await api<Notepad>(`/api/clients/${encodeURIComponent(clientId)}/notepad`, {
          method: "PUT",
          body: JSON.stringify({ text: sending, baseVersion: base.current.version }),
        });
        apply(saved);
        // Les deux versions gardées par le serveur : affichées si rien n'a été tapé depuis l'envoi.
        if (saved.text !== sending && textRef.current === sending) {
          textRef.current = saved.text;
          setText(saved.text);
        }
        setStatus(textRef.current === saved.text ? "saved" : "dirty");
        if (saved.conflict) toast.warning("Bloc-notes modifié sur un autre appareil : les deux versions sont gardées, à relire.");
      }
    } catch (e) {
      if (offlineEnabled() && (isOfflineError(e) || isServerDown(e))) await toQueue();
      else {
        setStatus("error");
        toast.error(errorMessage(e, "Bloc-notes non enregistré."));
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }, [apply, clientId, clientName, local, online, pending]);

  function onChange(value: string) {
    textRef.current = value;
    setText(value);
    setStatus("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  }

  // Saisie non enregistrée : le navigateur prévient avant de quitter, « Recharger » (mise à jour) aussi.
  useUnsavedGuard(status === "dirty" || status === "saving");

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const blocked = readOnly && !canPrepare;
  const statusText =
    status === "saving"
      ? "Enregistrement…"
      : status === "dirty"
        ? "Modifications en cours"
        : status === "queued" || pending
          ? "À envoyer : enregistré sur l'appareil, partira au retour du réseau"
          : status === "error"
            ? "Non enregistré : modifiez ou quittez le champ pour réessayer"
            : savedAt
              ? `Enregistré le ${hhmm(savedAt)}`
              : "";

  return (
    <Card className="p-5" data-client-notepad>
      <h2 id={titleId} className="mb-3 text-sm font-semibold">
        Bloc-notes
      </h2>
      {conflictAt ? (
        <Banner level="warning" className="mb-3">
          Modifié sur deux appareils le {hhmm(conflictAt)} : les deux versions sont gardées ci-dessous, à relire. Ce bandeau
          disparaît au prochain enregistrement.
        </Banner>
      ) : null}
      {loadError ? (
        <p className="text-sm text-[var(--muted)]">{loadError}</p>
      ) : !loaded ? (
        <div className="h-40 animate-pulse rounded-[var(--radius-sm)] bg-[var(--surface-raised)]" aria-hidden />
      ) : (
        <>
          <Textarea
            aria-labelledby={titleId}
            aria-describedby={statusId}
            rows={10}
            maxLength={MAX}
            value={text}
            disabled={blocked}
            placeholder="Rendez-vous, besoins, idées : tout ce qui concerne ce client, enregistré au fil de la frappe."
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => void save()}
          />
          <p id={statusId} role="status" className="mt-2 min-h-5 text-xs text-[var(--muted)]">
            {statusText}
          </p>
        </>
      )}
    </Card>
  );
}
