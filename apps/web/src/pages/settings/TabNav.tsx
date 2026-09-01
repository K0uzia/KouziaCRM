import type { SettingsTabId } from "./types";
import { SETTINGS_TABS } from "./types";

export function SettingsTabNav({
  active,
  onChange,
}: {
  active: SettingsTabId;
  onChange: (id: SettingsTabId) => void;
}) {
  return (
    <>
      <nav
        className="flex gap-1 overflow-x-auto pb-1 md:hidden"
        aria-label="Onglets paramètres"
      >
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`shrink-0 rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition ${
              active === tab.id
                ? "bg-[var(--primary-soft)] text-[var(--primary)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <nav
        className="hidden w-56 shrink-0 flex-col gap-0.5 md:flex"
        aria-label="Onglets paramètres"
      >
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm font-medium transition ${
              active === tab.id
                ? "bg-[var(--primary-soft)] text-[var(--primary)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </>
  );
}
