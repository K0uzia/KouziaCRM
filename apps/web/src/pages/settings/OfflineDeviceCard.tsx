import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Select } from "@/components/ui/Field";
import { formatDate } from "@/lib/format";
import { offlineEnabled } from "@/lib/offline/config";
import {
  clearCopyFailure,
  lastOnlineAt,
  readCopyFailure,
  readDeviceOptions,
  storageStatus,
  writeDeviceOptions,
  type DeviceOptions,
} from "@/lib/offline/device";
import { pendingCount, wipeOfflineData } from "@/lib/offline/store";

const DAY_CHOICES = [null, 7, 14, 30, 90] as const;

function megabytes(bytes: number | null): string {
  if (bytes === null) return "inconnue";
  return `${(bytes / 1_048_576).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

/**
 * Copie hors ligne de cet appareil (lot 4) : options d'effacement, toutes désactivées par défaut (décision du
 * 17/10/2026), effacement immédiat, place utilisée et quota, stockage persistant, dernier échec d'écriture.
 */
export function OfflineDeviceCard() {
  const titleId = useId();
  const enabled = offlineEnabled();
  const [options, setOptions] = useState<DeviceOptions>(() => readDeviceOptions());
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof storageStatus>>>(null);
  const [failure, setFailure] = useState(() => readCopyFailure());
  const [pending, setPending] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void storageStatus().then(setStorage).catch(() => setStorage(null));
    void pendingCount().then(setPending).catch(() => setPending(0));
    setFailure(readCopyFailure());
  };
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled]);

  function save(next: DeviceOptions) {
    setOptions(next);
    writeDeviceOptions(next);
    toast.success("Option de cet appareil enregistrée");
  }

  async function wipeNow() {
    setBusy(true);
    try {
      await wipeOfflineData();
      clearCopyFailure();
      toast.success("Copie hors ligne effacée sur cet appareil");
      setConfirmOpen(false);
      refresh();
    } catch {
      toast.error("Effacement impossible : fermez les autres onglets de l'ERP puis réessayez.");
    } finally {
      setBusy(false);
    }
  }

  const last = lastOnlineAt();
  return (
    <Card className="space-y-5 border border-[var(--border)] p-5" aria-labelledby={titleId}>
      <div>
        <h2 id={titleId} className="text-base font-semibold">
          Cet appareil : copie hors ligne
        </h2>
        <p className="mt-1 max-w-xl text-xs text-[var(--muted)]">
          Clients, devis, factures et prestations consultés sont copiés, chiffrés, dans ce navigateur pour rester
          lisibles sans réseau. Rien n&apos;est effacé automatiquement, sauf si vous l&apos;activez ici. Ces options
          ne valent que pour cet appareil.
        </p>
      </div>

      {!enabled ? (
        <p className="text-sm text-[var(--muted)]">
          Le mode hors ligne ne s&apos;active que sur l&apos;adresse de l&apos;ERP par Internet : rien n&apos;est copié
          sur cet appareil.
        </p>
      ) : (
        <>
          <div className="space-y-4">
            <label className="flex min-h-11 items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={options.wipeOnLogout}
                onChange={(e) => save({ ...options, wipeOnLogout: e.target.checked })}
              />
              <span>
                Effacer la copie à la déconnexion
                <span className="block text-xs text-[var(--muted)]">
                  La clé de chiffrement est supprimée : la copie devient illisible. Les créations pas encore envoyées
                  sont gardées.
                </span>
              </span>
            </label>
            <Field label="Effacer après une période sans connexion" hint="Comptée depuis la dernière réponse du serveur ; jamais les créations à envoyer.">
              <Select
                value={options.wipeAfterDays === null ? "" : String(options.wipeAfterDays)}
                onChange={(e) => save({ ...options, wipeAfterDays: e.target.value ? Number(e.target.value) : null })}
              >
                {DAY_CHOICES.map((d) => (
                  <option key={d ?? "jamais"} value={d === null ? "" : String(d)}>
                    {d === null ? "Jamais" : `${d} jours`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--muted)]">Place utilisée par l&apos;ERP</dt>
              <dd className="tabular-nums">
                {storage ? `${megabytes(storage.usage)} sur ${megabytes(storage.quota)}` : "Inconnue (le navigateur ne la donne pas)"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Stockage persistant</dt>
              <dd>{storage?.persisted === true ? "Oui : le navigateur ne l'effacera pas de lui-même" : storage?.persisted === false ? "Non : le navigateur peut l'effacer s'il manque de place" : "Inconnu"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Dernière connexion au serveur</dt>
              <dd>{last ? formatDate(new Date(last).toISOString()) : "Jamais enregistrée"}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--muted)]">Écriture de la copie</dt>
              <dd className={failure ? "text-[var(--danger)]" : undefined}>
                {failure ? `Échec le ${formatDate(new Date(failure.at).toISOString())} : ${failure.message}` : "Aucun échec"}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
            <p className="text-xs text-[var(--muted)]">
              {pending > 0 ? `${pending} création${pending > 1 ? "s" : ""} préparée${pending > 1 ? "s" : ""} hors ligne pas encore envoyée${pending > 1 ? "s" : ""}.` : "Aucune création en attente d'envoi."}
            </p>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>
              Effacer maintenant
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Effacer la copie hors ligne de cet appareil ?"
        message={
          pending > 0
            ? `${pending} création${pending > 1 ? "s" : ""} préparée${pending > 1 ? "s" : ""} hors ligne pas encore envoyée${pending > 1 ? "s" : ""} ser${pending > 1 ? "ont" : "a"} perdue${pending > 1 ? "s" : ""}. La copie sera reconstituée au fil de vos consultations en ligne.`
            : "La clé est supprimée et la copie vidée. Elle sera reconstituée au fil de vos consultations en ligne."
        }
        confirmLabel="Effacer la copie"
        danger
        busy={busy}
        onConfirm={() => void wipeNow()}
        onClose={() => setConfirmOpen(false)}
      />
    </Card>
  );
}
