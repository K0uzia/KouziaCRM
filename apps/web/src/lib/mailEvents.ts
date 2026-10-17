/**
 * « La messagerie a changé » (lu, non lu, suppression, déplacement, synchro) : la carte Messagerie
 * du tableau de bord se relit, dans cet onglet comme dans un autre onglet ouvert sur l'ERP.
 */
const MAIL_CHANGED_EVENT = "kouzia:mail-changed";
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("kouzia-mail");

export function notifyMailChanged(): void {
  window.dispatchEvent(new Event(MAIL_CHANGED_EVENT));
  channel?.postMessage("changed");
}

export function onMailChanged(listener: () => void): () => void {
  window.addEventListener(MAIL_CHANGED_EVENT, listener);
  channel?.addEventListener("message", listener);
  return () => {
    window.removeEventListener(MAIL_CHANGED_EVENT, listener);
    channel?.removeEventListener("message", listener);
  };
}
