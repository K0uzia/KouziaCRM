import { afterEach, describe, expect, it, vi } from "vitest";
import { api, statusMessage } from "../api";
import { errorMessage, isOfflineError, isStaleChunk, OFFLINE_MESSAGE, OfflineError } from "../network";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api() hors ligne", () => {
  it("lève une OfflineError typée, en français, quand fetch échoue (réseau coupé)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await api("/api/clients").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfflineError);
    expect(isOfflineError(error)).toBe(true);
    expect((error as OfflineError).code).toBe("offline");
    expect((error as Error).message).toBe(OFFLINE_MESSAGE);
    expect((error as Error).message).not.toMatch(/fetch/i);
  });

  it("transmet une annulation voulue (AbortError) sans la convertir", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(api("/api/clients")).rejects.toBe(abort);
  });

  it("garde le message du serveur et son statut (401 distinct d'une coupure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, statusText: "Unauthorized" })),
    );
    const error = (await api("/api/clients").catch((e: unknown) => e)) as Error & { status?: number };
    expect(isOfflineError(error)).toBe(false);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Non authentifié");
  });

  it("n'affiche jamais le statusText anglais quand le serveur ne donne pas de message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502, statusText: "Bad Gateway" })));
    const error = (await api("/api/clients").catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(statusMessage(502));
    expect(error.message).not.toMatch(/Bad Gateway/);
  });
});

describe("isStaleChunk", () => {
  it.each([
    "Failed to fetch dynamically imported module: http://localhost:5173/src/pages/ClientsPage.tsx",
    "error loading dynamically imported module: /assets/ClientsPage-abc.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/SettingsPage-abc.css",
  ])("reconnaît « %s »", (message) => {
    expect(isStaleChunk(new TypeError(message))).toBe(true);
  });

  it("ignore une erreur de rendu ordinaire ou un échec d'API", () => {
    expect(isStaleChunk(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isStaleChunk(new OfflineError())).toBe(false);
  });
});

describe("errorMessage", () => {
  it("remplace un échec réseau brut par le message hors ligne", () => {
    expect(errorMessage(new TypeError("Failed to fetch"), "Erreur")).toBe(OFFLINE_MESSAGE);
    expect(errorMessage(new TypeError("NetworkError when attempting to fetch resource."), "Erreur")).toBe(OFFLINE_MESSAGE);
    expect(errorMessage(new TypeError("Load failed"), "Erreur")).toBe(OFFLINE_MESSAGE);
  });

  it("garde un message métier", () => {
    expect(errorMessage(new Error("Facture déjà émise"), "Erreur")).toBe("Facture déjà émise");
  });
});
