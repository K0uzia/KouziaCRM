import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Command } from "cmdk";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faChevronDown, faMagnifyingGlass, faPlus, faXmark } from "@fortawesome/free-solid-svg-icons";
import { useMediaQuery } from "@/lib/use-media-query";
import { useAnchoredPanel } from "@/lib/use-anchored-panel";
import { countOptions, filterGroups, findOption, type ComboboxGroup, type ComboboxOption } from "@/lib/combobox-filter";

export type { ComboboxGroup, ComboboxOption } from "@/lib/combobox-filter";

/*
 * Liste de choix avec recherche, sur cmdk. Motifs W3C ARIA Authoring Practices Guide (APG) :
 * - Combobox (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) : champ de recherche role="combobox",
 *   aria-autocomplete="list", aria-controls vers la liste, option active portée par aria-activedescendant
 *   (le focus reste dans le champ) ; Flèches, Début, Fin, Entrée pour choisir, Échap pour fermer.
 * - Listbox à options groupées (https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) : role="listbox",
 *   groupes role="group" nommés par leur titre, options role="option".
 * - Le déclencheur ouvre un panneau role="dialog" (comme l'exemple « Date Picker Combobox » de l'APG) :
 *   ancré sous le champ dès 640 px, plein écran modal en dessous (clavier virtuel, cibles de 44 px).
 * Échap ou un choix referment le panneau et rendent le focus au déclencheur.
 */

type Props = {
  /** Nom accessible du déclencheur et titre du panneau (« Client »). */
  label: string;
  groups: ComboboxGroup[];
  /** Valeur choisie. Absente en mode action : le déclencheur garde son texte (« Ajouter depuis le catalogue »). */
  value?: string | null;
  onChange: (value: string, option: ComboboxOption) => void;
  /** Texte du déclencheur sans choix. */
  placeholder: string;
  variant?: "field" | "action";
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_HEIGHT = 448;

export function Combobox({
  label,
  groups,
  value,
  onChange,
  placeholder,
  variant = "field",
  searchPlaceholder = "Rechercher…",
  emptyText = "Aucun résultat.",
  disabled = false,
  className = "",
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: Props) {
  const mobile = useMediaQuery("(max-width: 639.98px)");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const statusId = useId();

  const selected = variant === "field" ? findOption(groups, value) : undefined;
  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const count = countOptions(visible);

  /** Option active (aria-activedescendant) : le choix actuel s'il reste visible, sinon la première option. */
  function firstActive(nextGroups: ComboboxGroup[], keep?: string): string {
    const all = nextGroups.flatMap((g) => g.options).filter((o) => !o.disabled);
    return all.find((o) => o.value === keep)?.value ?? all[0]?.value ?? "";
  }

  function openPanel(initialQuery = "") {
    if (disabled) return;
    setQuery(initialQuery);
    setActive(firstActive(filterGroups(groups, initialQuery), selected?.value));
    setOpen(true);
  }

  function search(next: string) {
    setQuery(next);
    setActive(firstActive(filterGroups(groups, next)));
  }

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function choose(option: ComboboxOption) {
    onChange(option.value, option);
    close(true);
  }

  // Panneau ancré : sous le déclencheur, ou au-dessus quand la place manque en bas ; recalculé au défilement.
  const position = useAnchoredPanel(open && !mobile, triggerRef, { minWidth: PANEL_MIN_WIDTH, maxHeight: PANEL_MAX_HEIGHT });

  // Clic en dehors (ancré) : ferme sans reprendre le focus. Le libellé du champ compte comme le déclencheur.
  useEffect(() => {
    if (!open || mobile) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      const trigger = triggerRef.current;
      if (trigger && (trigger.contains(target) || trigger.closest("label")?.contains(target))) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, mobile]);

  // Plein écran : la page derrière ne défile pas.
  useEffect(() => {
    if (!open || !mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, mobile]);

  // Valeur active pilotée (ouverture, recherche) : cmdk marque bien l'option aria-selected, mais ne recalcule
  // aria-activedescendant que sur ses propres changements (clavier, pointeur). Le champ est donc aligné sur
  // l'option marquée ; React ne réécrit pas l'attribut tant que sa propre valeur ne change pas.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const item = panel?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
      for (const el of panel?.querySelectorAll("[cmdk-input], [cmdk-list]") ?? []) {
        if (item) el.setAttribute("aria-activedescendant", item.id);
        else el.removeAttribute("aria-activedescendant");
      }
      // cmdk ne fait défiler qu'au clavier : l'option active est amenée à l'écran.
      item?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active, query]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openPanel();
    } else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Frappe sur le déclencheur fermé : la recherche démarre avec cette lettre.
      e.preventDefault();
      openPanel(e.key);
    }
  }

  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      // Arrêté ici : une modale en dessous (formulaire de devis) ne se ferme pas avec le panneau.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "Tab") return;
    e.stopPropagation();
    if (mobile) {
      // Panneau modal : le focus tourne entre la recherche et « Fermer ».
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("input, button") ?? []);
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (items.length > 0) {
        e.preventDefault();
        items[(index + (e.shiftKey ? items.length - 1 : 1)) % items.length]?.focus();
      }
      return;
    }
    // Panneau ancré : Tab le referme et rend la main au déclencheur, la tabulation suivante reprend la page.
    e.preventDefault();
    close(true);
  }

  const triggerText = selected ? selected.label : placeholder;
  const triggerName = selected ? `${label} : ${selected.label}` : variant === "action" ? placeholder : label;

  const panel = open ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={mobile || undefined}
      aria-labelledby={titleId}
      onKeyDown={onPanelKeyDown}
      style={mobile ? undefined : position}
      className={
        mobile
          ? "fixed inset-0 z-[60] flex h-dvh flex-col bg-[var(--surface)] pb-[env(safe-area-inset-bottom)]"
          : "fixed z-[60] flex flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow)]"
      }
    >
      <div className={mobile ? "flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2" : "sr-only"}>
        <h2 id={titleId} className="min-w-0 truncate text-base font-semibold">
          {label}
        </h2>
        {mobile ? (
          <button
            type="button"
            onClick={() => close(true)}
            aria-label="Fermer"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--bg)] hover:text-[var(--text)]"
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden />
          </button>
        ) : null}
      </div>
      <Command
        label={label}
        shouldFilter={false}
        loop
        value={active}
        onValueChange={setActive}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Indicateur de focus sur toute la ligne de recherche : le contour global du champ couperait l'icône. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-[var(--primary)]">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={search}
            placeholder={searchPlaceholder}
            aria-describedby={statusId}
            className="min-h-11 w-full min-w-0 bg-transparent py-2.5 text-base text-[var(--text)] placeholder:text-[var(--muted)] focus-visible:!outline-none sm:text-sm"
          />
        </div>
        <Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {count === 0 ? <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">{emptyText}</p> : null}
          {visible.map((group, gi) => (
            <Command.Group
              key={group.heading || gi}
              heading={group.heading || undefined}
              className={`${gi > 0 ? "mt-1.5 border-t border-[var(--border)] pt-1.5" : ""} [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-[1] [&_[cmdk-group-heading]]:bg-[var(--surface)] [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--muted)]`}
            >
              {group.options.map((option) => {
                const isCurrent = option.value === selected?.value;
                return (
                  <Command.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    onSelect={() => choose(option)}
                    className="flex min-h-11 cursor-pointer scroll-mt-10 items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60 data-[selected=true]:bg-[var(--surface-hover)] data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:outline-[var(--primary)]"
                  >
                    <span className="flex w-4 shrink-0 justify-center text-[var(--primary)]">
                      {isCurrent ? <FontAwesomeIcon icon={faCheck} className="h-3.5 w-3.5" aria-hidden /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">
                        {option.label}
                        {isCurrent ? <span className="sr-only"> (choix actuel)</span> : null}
                      </span>
                      {option.description ? (
                        <span className="block truncate text-xs text-[var(--muted)]">{option.description}</span>
                      ) : null}
                    </span>
                    {option.meta || option.metaDetail ? (
                      <span className="shrink-0 text-right tabular-nums">
                        {option.meta ? <span className="block whitespace-nowrap font-medium">{option.meta}</span> : null}
                        {option.metaDetail ? (
                          <span className="block whitespace-nowrap text-xs text-[var(--muted)]">{option.metaDetail}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
      <p id={statusId} role="status" className="sr-only">
        {count === 0 ? emptyText : count === 1 ? "1 résultat" : `${count} résultats`}
      </p>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerName}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={onTriggerKeyDown}
        className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-input)] bg-[var(--surface-raised)] px-3 py-2 text-left text-sm text-[var(--text)] ui-field transition hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:bg-[var(--bg-subtle)] disabled:opacity-70 ${className}`}
      >
        {variant === "action" ? (
          <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" aria-hidden />
        ) : null}
        <span className={`min-w-0 flex-1 truncate ${selected || variant === "action" ? "" : "text-[var(--muted)]"}`}>{triggerText}</span>
        {selected?.meta ? <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">{selected.meta}</span> : null}
        <FontAwesomeIcon icon={faChevronDown} className="h-3 w-3 shrink-0 text-[var(--muted)]" aria-hidden />
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  );
}
