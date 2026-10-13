import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, formatDate } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupport,
  type PushConfig,
  type PushDevice,
} from "@/lib/push";

const EVENTS = "devis accepté ou refusé, paiement reçu, nouvel e-mail (expéditeur et objet, sans extrait), nouveau client venu du site, abonnement modifié dans Stripe";

/** Réglages > Notifications : notifications push sur ce téléphone ou cet ordinateur. */
export function NotificationsTab() {
  const support = pushSupport();
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    typeof Notification === "undefined" ? null : Notification.permission,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PushDevice | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([
        api<PushConfig>("/api/push/config"),
        api<PushDevice[]>("/api/push/subscriptions"),
      ]);
      setConfig(cfg);
      setDevices(list);
      setThisEndpoint((await currentSubscription())?.endpoint ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const thisDevice = devices.find((d) => d.endpoint === thisEndpoint) ?? null;

  async function enable() {
    if (!config?.enabled) return;
    setBusy(true);
    try {
      const result = await enablePush(config.publicKey);
      setPermission(result);
      if (result === "granted") toast.success("Notifications activées sur cet appareil");
      else toast.error("Notifications refusées : autorisez-les dans les réglages du navigateur.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Activation impossible");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await disablePush(devices);
      toast.success("Notifications désactivées sur cet appareil");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Désactivation impossible");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await api<{ sent: number }>("/api/push/test", { method: "POST", body: "{}" });
      toast.success(`Notification de test envoyée à ${r.sent} appareil${r.sent > 1 ? "s" : ""}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Envoi impossible");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(d: PushDevice) {
    try {
      // Cet appareil : le navigateur est aussi désabonné (sinon il garderait un abonnement inutile).
      if (d.endpoint === thisEndpoint) await (await currentSubscription())?.unsubscribe();
      await api(`/api/push/subscriptions/${d.id}`, { method: "DELETE" });
      toast.success(`« ${d.label} » ne recevra plus de notifications`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retrait impossible");
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 border border-[var(--border)] p-5">
        <div>
          <h2 className="text-base font-semibold">Notifications push</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Une notification sur cet appareil, même ERP fermé : {EVENTS}.
          </p>
        </div>

        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-[var(--danger)]">
            {loadError}
            <Button variant="secondary" onClick={() => void load()}>
              Réessayer
            </Button>
          </div>
        ) : !config ? (
          <div role="status" aria-busy="true" className="h-11 animate-pulse rounded-[var(--radius)] bg-[var(--surface-raised)]">
            <span className="sr-only">Chargement…</span>
          </div>
        ) : support === "insecure" ? (
          <p className="text-sm text-[var(--warning)]">
            Les notifications push ne fonctionnent qu&apos;en https : ouvrez l&apos;ERP par https://erp.kouzia.com,
            pas par l&apos;adresse IP du réseau local.
          </p>
        ) : support === "unsupported" ? (
          <p className="text-sm text-[var(--warning)]">
            Ce navigateur ne gère pas les notifications push. Sur Android : Chrome ou Samsung Internet ; sur iPhone,
            ajoutez d&apos;abord l&apos;ERP à l&apos;écran d&apos;accueil.
          </p>
        ) : !config.enabled ? (
          <p className="text-sm text-[var(--warning)]">
            Notifications push désactivées sur le serveur : {config.reason}.
          </p>
        ) : permission === "denied" ? (
          <p className="text-sm text-[var(--warning)]">
            Notifications bloquées pour ce site : autorisez-les dans les réglages du navigateur (cadenas, Autorisations,
            Notifications), puis revenez ici.
          </p>
        ) : thisDevice ? (
          <div className="space-y-3">
            <p className="text-sm">
              Activées sur cet appareil (<span className="font-medium">{thisDevice.label}</span>).
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void test()} disabled={busy}>
                Envoyer une notification de test
              </Button>
              <Button variant="secondary" onClick={() => void disable()} disabled={busy}>
                Désactiver sur cet appareil
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Button onClick={() => void enable()} disabled={busy}>
              {busy ? "Activation…" : "Activer sur cet appareil"}
            </Button>
            <p className="text-xs text-[var(--muted)]">
              Le navigateur demande l&apos;autorisation. Sur téléphone, ajoutez aussi l&apos;ERP à l&apos;écran
              d&apos;accueil pour l&apos;ouvrir comme une application.
            </p>
          </div>
        )}
      </Card>

      {devices.length > 0 ? (
        <Card className="space-y-3 border border-[var(--border)] p-5">
          <h2 className="text-base font-semibold">Appareils qui reçoivent les notifications</h2>
          <ul className="divide-y divide-[var(--border)]">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {d.label}
                    {d.endpoint === thisEndpoint ? <span className="ml-2 text-xs text-[var(--muted)]">(cet appareil)</span> : null}
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    Ajouté le {formatDate(d.createdAt)}
                    {d.lastSuccessAt ? ` · dernière notification le ${formatDate(d.lastSuccessAt)}` : ""}
                    {d.lastError ? ` · dernière erreur : ${d.lastError}` : ""}
                  </p>
                </div>
                <Button variant="danger-ghost" onClick={() => setRemoving(d)}>
                  Retirer
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        title="Retirer cet appareil"
        message={`« ${removing?.label ?? ""} » ne recevra plus de notifications push. Vous pourrez les réactiver depuis cet appareil.`}
        confirmLabel="Retirer"
        danger
        onConfirm={() => removing && void remove(removing)}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
