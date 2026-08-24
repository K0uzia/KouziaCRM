"use client";

import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faTimes } from "@fortawesome/free-solid-svg-icons";
import { formatEUR } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type InvoiceSearchHit = {
  id: string;
  number: string | null;
  displayName: string;
  paidCents: number;
};

type Props = {
  selectedId: string | null;
  selectedLabel?: string | null;
  onSelect: (invoice: InvoiceSearchHit | null) => void;
  className?: string;
};

/**
 * Recherche facture (debounce) — remplace un Select ingérable à 500+ lignes.
 */
export function InvoiceSearch({ selectedId, selectedLabel, onSelect, className }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<InvoiceSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/invoices/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error("search failed");
        setHits((await res.json()) as InvoiceSearchHit[]);
        setOpen(true);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  if (selectedId) {
    return (
      <div
        className={cn(
          "flex h-9 min-w-[220px] max-w-[280px] items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-sm",
          className,
        )}
      >
        <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3 w-3 shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate text-gray-900">
          {selectedLabel ?? "Facture sélectionnée"}
        </span>
        <button
          type="button"
          aria-label="Effacer la simulation"
          className="shrink-0 text-gray-400 hover:text-gray-700"
          onClick={() => {
            onSelect(null);
            setQuery("");
          }}
        >
          <FontAwesomeIcon icon={faTimes} className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={cn("relative min-w-[220px] max-w-[280px]", className)}>
      <div className="relative">
        <FontAwesomeIcon
          icon={faMagnifyingGlass}
          className="pointer-events-none absolute left-3 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          placeholder="Rechercher une facture…"
          className="h-9 border-gray-200 bg-white pl-8 text-sm"
        />
      </div>
      {open && (loading || hits.length > 0 || query.trim().length > 0) ? (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-md">
          {loading ? (
            <li className="px-3 py-2 text-xs text-gray-400">Recherche…</li>
          ) : hits.length === 0 ? (
            <li className="px-3 py-2 text-xs text-gray-400">Aucun résultat</li>
          ) : (
            hits.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                  onClick={() => {
                    onSelect(hit);
                    setQuery("");
                    setOpen(false);
                    setHits([]);
                  }}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-gray-900">{hit.number ?? "—"}</span>
                    <span className="text-gray-500"> · {hit.displayName}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-gray-400">
                    {formatEUR(hit.paidCents)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
