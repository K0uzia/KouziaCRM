import { afterEach, describe, expect, it, vi } from "vitest";

// Rendu sans React : l'effet s'exécute tout de suite et rend sa fonction de nettoyage.
const cleanups: Array<() => void> = [];
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn();
      if (cleanup) cleanups.push(cleanup);
    },
  };
});

const listeners = new Map<string, Array<(e: { preventDefault: () => void }) => void>>();
vi.stubGlobal("window", {
  addEventListener: (type: string, fn: (e: { preventDefault: () => void }) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  removeEventListener: (type: string, fn: unknown) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
});

const { allowLeave, hasUnsavedChanges, useUnsavedGuard } = await import("../unsaved");

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: { preventDefault: () => void }) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: unknown) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
  });
});

describe("saisies non enregistrées (« Recharger » et fermeture de l'onglet)", () => {
  it("écran signalé : saisie en cours tant qu'il l'est ; alerte du navigateur jusqu'au départ confirmé", () => {
    expect(hasUnsavedChanges()).toBe(false);
    useUnsavedGuard(true);
    expect(hasUnsavedChanges()).toBe(true);
    const prevented = vi.fn();
    listeners.get("beforeunload")!.forEach((f) => f({ preventDefault: prevented }));
    expect(prevented).toHaveBeenCalledTimes(1);

    allowLeave();
    listeners.get("beforeunload")!.forEach((f) => f({ preventDefault: prevented }));
    expect(prevented).toHaveBeenCalledTimes(1);

    cleanups.pop()!();
    expect(hasUnsavedChanges()).toBe(false);
    expect(listeners.get("beforeunload")).toEqual([]);
  });

  it("écran inactif : rien de signalé", () => {
    useUnsavedGuard(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("fenêtre ouverte avec un formulaire : saisie en cours", () => {
    vi.stubGlobal("document", { querySelector: (sel: string) => (sel === '[role="dialog"] form' ? {} : null) });
    expect(hasUnsavedChanges()).toBe(true);
    vi.stubGlobal("document", { querySelector: () => null });
    expect(hasUnsavedChanges()).toBe(false);
  });
});
