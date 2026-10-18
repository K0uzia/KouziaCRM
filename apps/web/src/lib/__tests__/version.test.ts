import { afterEach, describe, expect, it, vi } from "vitest";
import { API_CONTRACT, BUILD_HEADER, CONTRACT_HEADER } from "@kouzia-erp/api-contract";
import { checkVersionHeaders, resetVersionForTests, useVersionState } from "../version";

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  // Lecture directe de l'état, sans rendu React.
  return { ...real, useSyncExternalStore: (_s: unknown, get: () => unknown) => get() };
});

afterEach(() => resetVersionForTests());

describe("interface plus ancienne que le serveur", () => {
  it("même contrat, build de développement : rien à signaler", () => {
    checkVersionHeaders(new Headers({ [CONTRACT_HEADER]: String(API_CONTRACT), [BUILD_HEADER]: "autre-build" }));
    expect(useVersionState()).toBe("ok");
  });

  it("contrat différent : rechargement obligatoire, et il prime ensuite sur un simple nouveau build", () => {
    checkVersionHeaders(new Headers({ [CONTRACT_HEADER]: String(API_CONTRACT + 1) }));
    expect(useVersionState()).toBe("contract");
    checkVersionHeaders(new Headers({ [CONTRACT_HEADER]: String(API_CONTRACT) }));
    expect(useVersionState()).toBe("contract");
  });

  it("autres onglets prévenus par BroadcastChannel", () => {
    const posted: unknown[] = [];
    class FakeChannel {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage(m: unknown) {
        posted.push(m);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.resetModules();
    return import("../version").then((m) => {
      m.checkVersionHeaders(new Headers({ [CONTRACT_HEADER]: String(API_CONTRACT + 1) }));
      expect(posted).toEqual(["contract"]);
      vi.unstubAllGlobals();
    });
  });
});
