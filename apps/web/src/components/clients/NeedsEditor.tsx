import { useId, useRef, useState, type KeyboardEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowDown, faArrowUp, faPlus, faXmark } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

export type ClientNeed = { id: string; label: string; done: boolean };

export const MAX_NEEDS = 50;
const MAX_LABEL = 200;

// Identifiant local (le serveur garde ceux fournis) : crypto.randomUUID n'existe pas en HTTP LAN.
const localId = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Liste de besoins éditable : saisie rapide (Entrée ajoute et vide le champ, compatible dictée
 * mobile), libellés modifiables, suppression, ordre (↑ ↓ à partir de 640 px), « traité » en option.
 */
export function NeedsEditor({
  needs,
  onChange,
  showDone = false,
  disabled = false,
}: {
  needs: ClientNeed[];
  onChange: (needs: ClientNeed[]) => void;
  showDone?: boolean;
  disabled?: boolean;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLInputElement>(null);
  const full = needs.length >= MAX_NEEDS;

  function add() {
    const label = draft.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    if (!label || full) return;
    onChange([...needs, { id: localId(), label, done: false }]);
    setDraft("");
    draftRef.current?.focus();
  }

  function onDraftKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    // Entrée ne soumet pas le formulaire englobant : elle ajoute le besoin.
    e.preventDefault();
    add();
  }

  const update = (index: number, patch: Partial<ClientNeed>) =>
    onChange(needs.map((n, i) => (i === index ? { ...n, ...patch } : n)));

  function remove(index: number) {
    onChange(needs.filter((_, i) => i !== index));
    draftRef.current?.focus();
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= needs.length) return;
    const next = [...needs];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {needs.length > 0 ? (
        <ul id={listId} className="space-y-2" aria-label="Besoins">
          {needs.map((need, i) => (
            <li key={need.id} className="flex min-w-0 items-center gap-1">
              {showDone ? (
                <label className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={need.done}
                    disabled={disabled}
                    aria-label={`Traité : ${need.label}`}
                    onChange={(e) => update(i, { done: e.target.checked })}
                  />
                </label>
              ) : null}
              <Input
                value={need.label}
                maxLength={MAX_LABEL}
                disabled={disabled}
                aria-label={`Besoin ${i + 1}`}
                className={`min-w-0 flex-1 ${need.done ? "text-[var(--muted)] line-through" : ""}`}
                onChange={(e) => update(i, { label: e.target.value })}
                onBlur={(e) => {
                  const label = e.target.value.replace(/\s+/g, " ").trim();
                  if (!label) remove(i);
                  else if (label !== need.label) update(i, { label });
                }}
              />
              <Button
                variant="ghost"
                className="hidden px-0 sm:inline-flex"
                disabled={disabled || i === 0}
                aria-label={`Monter : ${need.label}`}
                onClick={() => move(i, -1)}
              >
                <FontAwesomeIcon icon={faArrowUp} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                className="hidden px-0 sm:inline-flex"
                disabled={disabled || i === needs.length - 1}
                aria-label={`Descendre : ${need.label}`}
                onClick={() => move(i, 1)}
              >
                <FontAwesomeIcon icon={faArrowDown} aria-hidden />
              </Button>
              <Button
                variant="danger-ghost"
                className="px-0"
                disabled={disabled}
                aria-label={`Supprimer : ${need.label}`}
                onClick={() => remove(i)}
              >
                <FontAwesomeIcon icon={faXmark} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={draftRef}
          value={draft}
          maxLength={MAX_LABEL}
          disabled={disabled || full}
          placeholder={full ? `${MAX_NEEDS} besoins au plus` : "Ajouter un besoin…"}
          aria-label="Nouveau besoin"
          enterKeyHint="done"
          autoComplete="off"
          className="min-w-0 flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKey}
        />
        <Button
          variant="secondary"
          className="px-0"
          disabled={disabled || full || !draft.trim()}
          aria-label="Ajouter le besoin"
          onClick={add}
        >
          <FontAwesomeIcon icon={faPlus} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
