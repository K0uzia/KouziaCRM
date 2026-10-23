/**
 * CVE-2026-111497 (décodeur Brotli de Node, correctifs du 21/10/2026) : les réponses des services extérieurs ne sont
 * pas demandées en Brotli. Chaque fetch du serveur (GitHub, site, notifications push, API publiques d'adresses et
 * d'entreprises, Google) annonce Accept-Encoding: gzip, deflate ; une réponse annoncée en br malgré tout est refusée
 * et son corps abandonné sans être lu. Stripe passe par son propre client HTTP (module https), hors fetch.
 * Limite : le décodeur de fetch peut recevoir les premiers octets d'une réponse br forcée avant l'abandon ; seule la
 * mise à jour de Node corrige le décodeur lui-même.
 */
export class BrotliResponseError extends Error {}

let installed = false;

export function installNoBrotliFetch(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("accept-encoding", "gzip, deflate");
    const res = await original(input, { ...init, headers });
    if (/\bbr\b/i.test(res.headers.get("content-encoding") ?? "")) {
      await res.body?.cancel().catch(() => undefined);
      const url = input instanceof Request ? input.url : String(input);
      throw new BrotliResponseError(`Réponse compressée en Brotli refusée : ${new URL(url).host}`);
    }
    return res;
  };
}
