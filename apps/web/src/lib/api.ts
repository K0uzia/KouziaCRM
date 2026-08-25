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
    try {
      const body = await res.json();
      if (typeof body.error === "string") message = body.error;
      else if (body.error?.formErrors) message = "Données invalides";
    } catch {
      /* ignore */
    }
    throw new Error(message || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return undefined as T;
}

export { formatEUR, formatDate } from "./format";
