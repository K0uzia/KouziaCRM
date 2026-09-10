import type { SettingsTabId } from "./types";
import { SETTINGS_TABS } from "./types";

const GROUPS: Array<{ label: string; ids: SettingsTabId[] }> = [
  { label: "Entreprise", ids: ["general", "identity", "declarations"] },
  { label: "Facturation", ids: ["payments", "numbering", "legal", "reminders"] },
  { label: "Communication", ids: ["email"] },
];

function tabButton(
  tab: { id: SettingsTabId; label: string },
  active: SettingsTabId,
  onChange: (id: SettingsTabId) => void,
  className: string,
) {
  return (
    <button
      key={tab.id}
      type="button"
      onClick={() => onChange(tab.id)}
      className={`${className} ${
        active === tab.id
          ? "bg-[var(--primary-soft)] text-[var(--primary)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      }`}
    >
      {tab.label}
    </button>
  );
}

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
        {SETTINGS_TABS.map((tab) =>
          tabButton(
            tab,
            active,
            onChange,
            "shrink-0 rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition",
          ),
        )}
      </nav>
      <nav
        className="hidden w-56 shrink-0 flex-col gap-4 md:flex"
        aria-label="Onglets paramètres"
      >
        {GROUPS.map((group) => (
          <div key={group.label} className="space-y-0.5">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              {group.label}
            </p>
            {group.ids.map((id) => {
              const tab = SETTINGS_TABS.find((t) => t.id === id);
              if (!tab) return null;
              return tabButton(
                tab,
                active,
                onChange,
                "w-full rounded-[var(--radius-sm)] px-3 py-2 text-left text-sm font-medium transition",
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
