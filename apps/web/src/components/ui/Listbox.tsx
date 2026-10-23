import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { useAnchoredPanel } from "@/lib/use-anchored-panel";
import { firstEnabled, lastEnabled, readOptions, step, typeahead, type ListOption } from "@/lib/listbox";

/*
 * Liste de choix au design de l'ERP, motif W3C APG « Select-Only Combobox »
 * (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/) : le focus reste sur le
 * déclencheur role="combobox", l'option active est portée par aria-activedescendant. Fermé : Flèches, Entrée,
 * Espace, Alt+Bas ouvrent ; Début et Fin ouvrent sur la première ou la dernière option ; une lettre ouvre et cherche.
 * Ouvert : Flèches, Début, Fin, Page préc. et suiv. (10 options) ; Entrée, Espace, Alt+Haut et Tab choisissent ;
 * Échap referme sans changer. Même API que <select> (enfants <option> et <optgroup>, onChange lisant target.value).
 * Écrit ici plutôt que pris dans une bibliothèque : même socle et même allure que le Combobox (décision E4, 23/10/2026).
 */

const MAX_HEIGHT = 320;
const TYPEAHEAD_MS = 500;

type Props = SelectHTMLAttributes<HTMLSelectElement>;

export function Listbox({
  value,
  defaultValue,
  onChange,
  children,
  disabled,
  className = "",
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  title,
}: Props) {
  const options = useMemo(() => readOptions(children), [children]);
  const [inner, setInner] = useState(() => String(defaultValue ?? options[0]?.value ?? ""));
  const current = value === undefined ? inner : String(value);
  const selectedIndex = options.findIndex((o) => o.value === current);
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const baseId = useId();
  const listId = `${baseId}-liste`;
  const optionId = (i: number) => `${baseId}-option-${i}`;
  const position = useAnchoredPanel(open, triggerRef, { minWidth: 0, maxHeight: MAX_HEIGHT, flipBelow: 200 });

  // Nom de la liste : celui du champ (aria-label, sinon le libellé du <label> qui l'entoure, sans son aide).
  const [listName, setListName] = useState("");
  function openAt(index: number) {
    if (disabled) return;
    const label = triggerRef.current?.closest("label");
    setListName(ariaLabel ?? label?.querySelector("span")?.textContent?.trim() ?? "");
    setActive(index >= 0 ? index : selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
    setOpen(true);
  }

  function close() {
    setOpen(false);
    typed.current.text = "";
  }

  function choose(index: number) {
    const option = options[index];
    close();
    if (!option || option.disabled || option.value === current) return;
    if (value === undefined) setInner(option.value);
    const target = { value: option.value };
    onChange?.({ target, currentTarget: target } as unknown as ChangeEvent<HTMLSelectElement>);
  }

  function search(char: string, from: number): number {
    const now = Date.now();
    const buffer = now - typed.current.at > TYPEAHEAD_MS ? char : typed.current.text + char;
    typed.current = { text: buffer, at: now };
    return typeahead(options, buffer, from);
  }

  // L'option active reste visible quand on la déplace au clavier.
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // Clic en dehors : ferme sans choisir. Le libellé du champ compte comme le déclencheur.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target)) return;
      const trigger = triggerRef.current;
      if (trigger && (trigger.contains(target) || trigger.closest("label")?.contains(target))) return;
      close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openAt(-1);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        openAt(e.key === "Home" ? firstEnabled(options) : lastEnabled(options));
      } else if (printable) {
        e.preventDefault();
        const found = search(e.key, selectedIndex);
        openAt(found);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (e.altKey && e.key === "ArrowUp") return choose(active);
        setActive((i) => step(options, i, e.key === "ArrowDown" ? 1 : -1));
        return;
      case "PageDown":
      case "PageUp":
        e.preventDefault();
        setActive((i) => step(options, i, e.key === "PageDown" ? 10 : -10));
        return;
      case "Home":
      case "End":
        e.preventDefault();
        setActive(e.key === "Home" ? firstEnabled(options) : lastEnabled(options));
        return;
      case "Enter":
      case " ":
        if (e.key === " " && typed.current.text && Date.now() - typed.current.at < TYPEAHEAD_MS) {
          // Espace dans une recherche en cours (« En % ») : fait partie de la saisie.
          e.preventDefault();
          const found = search(" ", active);
          if (found >= 0) setActive(found);
          return;
        }
        e.preventDefault();
        choose(active);
        return;
      case "Escape":
        // Arrêté ici : la fenêtre modale en dessous ne se ferme pas avec la liste.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "Tab":
        choose(active);
        return;
      default:
        if (printable) {
          e.preventDefault();
          const found = search(e.key, active);
          if (found >= 0) setActive(found);
        }
    }
  }

  const groups: Array<{ name: string | null; items: Array<{ option: ListOption; index: number }> }> = [];
  options.forEach((option, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === option.group) last.items.push({ option, index });
    else groups.push({ name: option.group, items: [{ option, index }] });
  });

  const renderOption = ({ option, index }: { option: ListOption; index: number }) => {
    const isSelected = index === selectedIndex;
    return (
      <li
        key={index}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled || undefined}
        // Le focus reste sur le déclencheur : le clic ne le lui retire pas.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => !option.disabled && choose(index)}
        onPointerMove={() => !option.disabled && active !== index && setActive(index)}
        className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm ${
          index === active ? "bg-[var(--surface-hover)] outline outline-1 outline-[var(--primary)]" : ""
        } ${option.disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <span className="flex w-4 shrink-0 justify-center text-[var(--primary)]">
          {isSelected ? <FontAwesomeIcon icon={faCheck} className="h-3.5 w-3.5" aria-hidden /> : null}
        </span>
        <span className="min-w-0 flex-1 break-words">{option.label}</span>
      </li>
    );
  };

  const panel = open ? (
    <ul
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={listName || undefined}
      aria-labelledby={listName ? undefined : labelledBy}
      style={position}
      className="fixed z-[60] overflow-y-auto overscroll-contain rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow)]"
    >
      {groups.map((g, gi) =>
        g.name === null ? (
          g.items.map(renderOption)
        ) : (
          <li key={`g${gi}`} role="presentation" className={gi > 0 ? "mt-1.5 border-t border-[var(--border)] pt-1.5" : ""}>
            <span id={`${baseId}-groupe-${gi}`} className="block px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              {g.name}
            </span>
            <ul role="group" aria-labelledby={`${baseId}-groupe-${gi}`}>
              {g.items.map(renderOption)}
            </ul>
          </li>
        ),
      )}
    </ul>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        onClick={() => (open ? close() : openAt(-1))}
        onKeyDown={onKeyDown}
        // Espace : un bouton se déclenche au relâchement ; l'ouverture est déjà faite à l'appui.
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        onBlur={() => open && close()}
        className={`text-left ${className}`}
      >
        {/* Largeur de la plus longue option, comme un <select> : le champ ne change pas de taille au choix. */}
        <span className="grid min-w-0 [grid-template-areas:'v']">
          {options.map((o, i) => (
            <span key={i} aria-hidden className="invisible h-0 whitespace-nowrap [grid-area:v]">
              {o.label}
            </span>
          ))}
          <span className="truncate [grid-area:v]">{selected?.label ?? ""}</span>
        </span>
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  );
}
