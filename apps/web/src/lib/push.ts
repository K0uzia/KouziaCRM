import { api } from "@/lib/api";

/** État des notifications push sur cet appareil (navigateur). */
export type PushSupport = "ok" | "insecure" | "unsupported";

export type PushDevice = {
  id: string;
  endpoint: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
};

export type PushConfig = { enabled: true; publicKey: string } | { enabled: false; reason: string };

export function pushSupport(): PushSupport {
  // Le push exige https (ou localhost) : pas d'accès par l'adresse IP du réseau local.
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    return "unsupported";
  }
  return "ok";
}

/** Nom lisible de l'appareil, pour la liste (« Chrome sur Android »). */
export function deviceLabel(ua = navigator.userAgent): string {
  const browser = /SamsungBrowser/i.test(ua)
    ? "Samsung Internet"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Navigateur";
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iPhone"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X/i.test(ua)
          ? "Mac"
          : /Linux/i.test(ua)
            ? "Linux"
            : "appareil inconnu";
  return `${browser} sur ${os}`;
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** Abonnement push actuel de cet appareil (null si aucun). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Demande l'autorisation, abonne l'appareil et l'enregistre côté serveur. */
export async function enablePush(publicKey: string): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  const json = sub.toJSON();
  await api("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: deviceLabel() }),
  });
  return permission;
}

/** Désabonne cet appareil (navigateur puis serveur). */
export async function disablePush(devices: PushDevice[]): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const mine = devices.find((d) => d.endpoint === sub.endpoint);
  await sub.unsubscribe();
  if (mine) await api(`/api/push/subscriptions/${mine.id}`, { method: "DELETE" });
}
