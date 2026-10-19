// Imports relatifs uniquement : module testé par vitest sans l'alias « @ ».

/**
 * Notification de l'appareil en plus du toast ? Seulement quand l'ERP n'est pas à l'écran (onglet en arrière-plan,
 * appli réduite) et que la permission est accordée : jamais deux messages pour un même événement.
 */
export function shouldNotifySystem(
  env: { visibility?: DocumentVisibilityState; permission?: NotificationPermission } = {
    visibility: typeof document === "undefined" ? undefined : document.visibilityState,
    permission: typeof Notification === "undefined" ? undefined : Notification.permission,
  },
): boolean {
  return env.visibility === "hidden" && env.permission === "granted";
}
