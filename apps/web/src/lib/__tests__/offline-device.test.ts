import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dependsOn } from "../api";
import {
  applyRetention,
  DEFAULT_DEVICE_OPTIONS,
  lastOnlineAt,
  markOnline,
  readCopyFailure,
  readDeviceOptions,
  recordCopyFailure,
  wipeOnLogoutIfWanted,
  writeDeviceOptions,
} from "../offline/device";
import { deleteCopiesWhere, putSealed, readCopy, resetOfflineStoreForTests, saveCopy, wipeOfflineData } from "../offline/store";

const DAY = 86_400_000;

/** localStorage minimal (vitest tourne sous Node). */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  await resetOfflineStoreForTests();
  indexedDB.deleteDatabase("kouzia-hors-ligne");
});
afterEach(() => vi.unstubAllGlobals());

describe("options de la copie hors ligne de cet appareil", () => {
  it("désactivées par défaut ; valeurs hors bornes ignorées", () => {
    expect(readDeviceOptions()).toEqual(DEFAULT_DEVICE_OPTIONS);
    writeDeviceOptions({ wipeOnLogout: true, wipeAfterDays: 30 });
    expect(readDeviceOptions()).toEqual({ wipeOnLogout: true, wipeAfterDays: 30 });
    localStorage.setItem("kouzia:hors-ligne:options", JSON.stringify({ wipeOnLogout: "oui", wipeAfterDays: 9999 }));
    expect(readDeviceOptions()).toEqual(DEFAULT_DEVICE_OPTIONS);
  });

  it("stockage indisponible (navigation privée) : options par défaut, aucune erreur", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("refusé");
      },
      setItem: () => {
        throw new Error("refusé");
      },
    });
    expect(readDeviceOptions()).toEqual(DEFAULT_DEVICE_OPTIONS);
    expect(() => writeDeviceOptions({ wipeOnLogout: true, wipeAfterDays: null })).not.toThrow();
  });

  it("effacement après N jours sans connexion : seulement passé le délai, jamais avec des créations à envoyer", async () => {
    const now = Date.now();
    await saveCopy("/api/clients", [{ id: "c1" }]);
    writeDeviceOptions({ wipeOnLogout: false, wipeAfterDays: 7 });
    markOnline(now - 6 * DAY);
    expect(await applyRetention(now)).toBe("none");
    expect(await readCopy("/api/clients")).not.toBeNull();

    localStorage.setItem("kouzia:hors-ligne:derniere-connexion", JSON.stringify(now - 8 * DAY));
    await putSealed("file", "creation-1", { kind: "client" });
    expect(await applyRetention(now)).toBe("kept-pending");
    expect(await readCopy("/api/clients")).not.toBeNull();

    await (await import("../offline/store")).deleteSealed("file", "creation-1");
    expect(await applyRetention(now)).toBe("wiped");
    expect(await readCopy("/api/clients")).toBeNull();
    expect(lastOnlineAt()).toBe(now - 8 * DAY);
  });

  it("effacement à la déconnexion : seulement si l'option est cochée", async () => {
    await saveCopy("/api/services", []);
    expect(await wipeOnLogoutIfWanted()).toBe("none");
    expect(await readCopy("/api/services")).not.toBeNull();
    writeDeviceOptions({ wipeOnLogout: true, wipeAfterDays: null });
    expect(await wipeOnLogoutIfWanted()).toBe("wiped");
    expect(await readCopy("/api/services")).toBeNull();
  });

  it("clé supprimée par l'effacement : une copie écrite avant ne se relit plus, une nouvelle copie fonctionne", async () => {
    await saveCopy("/api/clients", [{ id: "c1" }]);
    await wipeOfflineData();
    expect(await readCopy("/api/clients")).toBeNull();
    await saveCopy("/api/clients", [{ id: "c2" }]);
    expect((await readCopy<Array<{ id: string }>>("/api/clients"))?.data).toEqual([{ id: "c2" }]);
  });

  it("échec d'écriture de la copie : quota plein dit en clair", () => {
    recordCopyFailure(Object.assign(new Error("x"), { name: "QuotaExceededError" }), 1_000);
    expect(readCopyFailure()).toEqual({ at: 1_000, message: "Espace de stockage plein" });
  });
});

describe("fiche disparue du serveur (404) : sa copie et ce qui en dépend", () => {
  it("client : fiche, notes, projets et listes de pièces du client ; rien d'autre", async () => {
    for (const path of [
      "/api/clients/c1",
      "/api/clients/c1/notes",
      "/api/clients/c1/projects",
      "/api/invoices?clientId=c1",
      "/api/invoices?type=QUOTE&clientId=c1",
      "/api/clients/c2",
      "/api/invoices?clientId=c2",
      "/api/clients",
    ]) {
      await saveCopy(path, {});
    }
    expect(await deleteCopiesWhere(dependsOn("/api/clients/c1"))).toBe(5);
    expect(await readCopy("/api/clients/c1/notes")).toBeNull();
    expect(await readCopy("/api/clients/c2")).not.toBeNull();
    expect(await readCopy("/api/invoices?clientId=c2")).not.toBeNull();
    expect(await readCopy("/api/clients")).not.toBeNull();
  });

  it("devis ou facture : seulement sa copie", () => {
    const match = dependsOn("/api/invoices/f1");
    expect(match("/api/invoices/f1")).toBe(true);
    expect(match("/api/invoices/f10")).toBe(false);
    expect(match("/api/invoices?clientId=f1")).toBe(false);
  });
});

describe("version du format des copies", () => {
  it("copie d'une autre version ignorée ; copie sans version (avant ce champ) lue comme format 1", async () => {
    const { COPY_FORMAT, putCopyForTests } = await import("../offline/store");
    await saveCopy("/api/services", [1]);
    expect((await readCopy("/api/services"))?.v).toBe(COPY_FORMAT);
    await putCopyForTests("/api/clients", { v: COPY_FORMAT + 1, savedAt: 1, data: [] });
    expect(await readCopy("/api/clients")).toBeNull();
    await putCopyForTests("/api/clients", { savedAt: 1, data: ["ancien"] });
    expect((await readCopy("/api/clients"))?.data).toEqual(["ancien"]);
  });
});
