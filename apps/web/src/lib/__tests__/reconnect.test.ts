import { afterEach, describe, expect, it, vi } from "vitest";

const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...args: unknown[]) => success(...args) } }));

const { refreshAfterReconnect } = await import("../reconnect");

afterEach(() => success.mockReset());

function steps(log: string[]) {
  return {
    replay: async () => void log.push("file"),
    remountPage: () => void log.push("page"),
    copy: async () => void log.push("copie"),
  };
}

describe("retour du réseau", () => {
  it("serveur joignable : file, puis page rechargée, puis copie, puis un seul toast", async () => {
    const log: string[] = [];
    const outcome = await refreshAfterReconnect(steps(log), { reachable: async () => true, busy: () => false, online: () => true });
    expect(outcome).toBe("done");
    expect(log).toEqual(["file", "page", "copie"]);
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]![0]).toBe("De nouveau en ligne, données à jour");
  });

  it("saisie en cours : la page attend la fin de la saisie pour se recharger, rien n'est perdu", async () => {
    const log: string[] = [];
    let typing = 2;
    const outcome = await refreshAfterReconnect(steps(log), {
      reachable: async () => true,
      busy: () => {
        log.push("saisie");
        return typing-- > 0;
      },
      online: () => true,
    });
    expect(outcome).toBe("done");
    expect(log).toEqual(["file", "saisie", "saisie", "saisie", "page", "copie"]);
  }, 5000);

  it("serveur injoignable après trois essais : rien n'est rechargé, pas de toast", async () => {
    const log: string[] = [];
    const reachable = vi.fn(async () => false);
    const outcome = await refreshAfterReconnect(steps(log), { reachable, busy: () => false, online: () => true, pauseMs: 1 });
    expect(outcome).toBe("unreachable");
    expect(reachable).toHaveBeenCalledTimes(3);
    expect(log).toEqual([]);
    expect(success).not.toHaveBeenCalled();
  });

  it("réseau retombé pendant la saisie : la page n'est pas rechargée", async () => {
    const log: string[] = [];
    let online = true;
    const outcome = await refreshAfterReconnect(steps(log), {
      reachable: async () => true,
      busy: () => {
        online = false;
        return true;
      },
      online: () => online,
    });
    expect(outcome).toBe("offline");
    expect(log).toEqual(["file"]);
  });
});
