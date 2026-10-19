import { describe, expect, it } from "vitest";
import { shouldNotifySystem } from "../system-notify";
import { markUpdateWaiting, resetVersionForTests, useVersionState } from "../version";

// Sources de l'interface, tests exclus : relues telles quelles (Vite, ?raw).
const RAW = import.meta.glob(["/src/**/*.ts", "/src/**/*.tsx", "!/src/**/__tests__/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const files = Object.entries(RAW).map(([path, text]) => ({ path: path.replace(/^\/src\//, ""), text }));

describe("messages de l'ERP : un seul style, jamais deux pour un même événement", () => {
  it("un seul Toaster (AppToaster), sans richColors : tous les toasts au fond de la charte", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /<Toaster\b/.test(f.text)).map((f) => f.path)).toEqual(["components/ui/AppToaster.tsx"]);
    expect(files.filter((f) => /richColors/.test(f.text)).map((f) => f.path)).toEqual([]);
    expect(files.filter((f) => /<AppToaster\b/.test(f.text)).map((f) => f.path)).toEqual(["main.tsx"]);
  });

  it("aucun toast sans pastille : ni toast() neutre ni toast.message()", () => {
    const offenders = files
      .filter((f) => !f.path.endsWith("AppToaster.tsx"))
      .flatMap((f) =>
        f.text
          .split("\n")
          .map((line, i) => ({ line, at: `${f.path}:${i + 1}` }))
          .filter(({ line }) => /(^|[^.\w])toast\(|toast\.message\(/.test(line)),
      )
      .map((o) => o.at);
    expect(offenders).toEqual([]);
  });

  it("notification de l'appareil seulement si l'ERP n'est pas à l'écran et la permission accordée", () => {
    expect(shouldNotifySystem({ visibility: "visible", permission: "granted" })).toBe(false);
    expect(shouldNotifySystem({ visibility: "hidden", permission: "granted" })).toBe(true);
    expect(shouldNotifySystem({ visibility: "hidden", permission: "default" })).toBe(false);
    expect(shouldNotifySystem({ visibility: undefined, permission: "granted" })).toBe(false);
  });

  it("nouvelle version en attente dans le service worker : le même état que le bandeau, pas un toast à part", () => {
    resetVersionForTests();
    expect(typeof useVersionState).toBe("function");
    markUpdateWaiting();
    const sw = files.find((f) => f.path === "lib/sw-register.ts")!.text;
    expect(sw).toMatch(/addEventListener\("waiting", \(\) => markUpdateWaiting\(\)\)/);
    expect(sw).not.toMatch(/from "sonner"/);
  });
});
