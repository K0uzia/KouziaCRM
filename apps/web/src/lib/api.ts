export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // Ne pas forcer JSON sur FormData (boundary multipart requis par le navigateur)
  if (
    init?.body &&
    !headers.has("Content-Type") &&
    !(init.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });

  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    let fieldErrors: Record<string, string> | undefined;
    try {
      const body = await res.json();
      if (typeof body.error === "string") message = body.error;
      else if (body.error?.formErrors) {
        message = "Données invalides";
        // Erreurs zod par champ (error.flatten()) : premier message de chaque champ.
        const entries = Object.entries((body.error.fieldErrors ?? {}) as Record<string, string[] | undefined>)
          .filter(([, list]) => list?.length)
          .map(([key, list]) => [key, list![0]!] as const);
        if (entries.length) fieldErrors = Object.fromEntries(entries);
      }
      // Erreurs zod sous forme de liste (espace Site) : { path: "testimonial.text", message }.
      if (Array.isArray(body.issues)) {
        const issues = body.issues as Array<{ path?: unknown; message?: unknown }>;
        fieldErrors = {};
        for (const i of issues) {
          const key = String(i.path ?? "");
          if (key && !(key in fieldErrors)) fieldErrors[key] = String(i.message ?? "");
        }
      }
      if (typeof body.code === "string") code = body.code;
    } catch {
      /* ignore */
    }
    // status et code (ex. « stripe_mode_change ») : l'appelant peut demander une confirmation.
    throw Object.assign(new Error(message || `HTTP ${res.status}`), { status: res.status, code, fieldErrors });
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return undefined as T;
}

export { formatEUR, formatDate } from "./format";
