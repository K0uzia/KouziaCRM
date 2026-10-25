import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBell,
  faBuilding,
  faCreditCard,
  faEnvelope,
  faEnvelopeOpenText,
  faGavel,
  faHashtag,
  faMobileScreenButton,
  faPalette,
  faScaleBalanced,
  faShieldHalved,
} from "@fortawesome/free-solid-svg-icons";
import type { SettingsTabId } from "./types";
import { SETTINGS_TABS } from "./types";
import { Link, useNavigate } from "react-router-dom";
import { Select } from "@/components/ui/Field";

const GROUPS: Array<{ label: string; ids: SettingsTabId[] }> = [
  { label: "Entreprise", ids: ["general", "identity", "declarations"] },
  { label: "Facturation", ids: ["payments", "numbering", "legal", "reminders"] },
  { label: "Communication", ids: ["email", "notifications"] },
  { label: "Compte", ids: ["security"] },
];

const ICONS: Record<SettingsTabId, IconDefinition> = {
  general: faBuilding,
  identity: faPalette,
  declarations: faScaleBalanced,
  payments: faCreditCard,
  numbering: faHashtag,
  legal: faGavel,
  reminders: faBell,
  email: faEnvelope,
  notifications: faMobileScreenButton,
  security: faShieldHalved,
};

/** Écrans propres d'un groupe (lien, pas un onglet) : affichés après ses onglets. */
const PAGES: Record<string, Array<{ to: string; label: string; icon: IconDefinition }>> = {
  Communication: [{ to: "/settings/modeles-emails", label: "Modèles d'e-mails", icon: faEnvelopeOpenText }],
};

/** Navigation des réglages : liste groupée (bureau), liste déroulante (mobile). */
export function SettingsTabNav({
  active,
  onChange,
}: {
  active: SettingsTabId;
  onChange: (id: SettingsTabId) => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <label className="block md:hidden">
        <span className="sr-only">Section des réglages</span>
        <Select value={active} onChange={(e) => (e.target.value.startsWith("/") ? navigate(e.target.value) : onChange(e.target.value as SettingsTabId))}>
          {GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.ids.map((id) => (
                <option key={id} value={id}>
                  {SETTINGS_TABS.find((t) => t.id === id)?.label ?? id}
                </option>
              ))}
              {(PAGES[group.label] ?? []).map((p) => (
                <option key={p.to} value={p.to}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </label>
      <nav className="hidden w-56 shrink-0 flex-col gap-5 md:flex" aria-label="Sections des réglages">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.ids.map((id) => {
                const tab = SETTINGS_TABS.find((t) => t.id === id);
                if (!tab) return null;
                const isActive = active === id;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => onChange(id)}
                      className={`relative flex min-h-10 w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 text-left text-sm transition-colors ${
                        isActive
                          ? "bg-[var(--primary-soft)] font-medium text-[var(--text)]"
                          : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                      }`}
                    >
                      {isActive ? (
                        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--primary)]" aria-hidden />
                      ) : null}
                      <FontAwesomeIcon
                        icon={ICONS[id]}
                        className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-[var(--primary)]" : ""}`}
                        aria-hidden
                      />
                      {tab.label}
                    </button>
                  </li>
                );
              })}
              {(PAGES[group.label] ?? []).map((p) => (
                <li key={p.to}>
                  <Link
                    to={p.to}
                    className="flex min-h-10 w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 text-left text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  >
                    <FontAwesomeIcon icon={p.icon} className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
