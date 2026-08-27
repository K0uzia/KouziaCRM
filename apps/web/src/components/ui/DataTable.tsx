import { useMemo, useState } from "react";
import DataTableBase, {
  type TableColumn,
  type TableProps,
} from "react-data-table-component";
import { EmptyState } from "./Card";

const customStyles: TableProps<never>["customStyles"] = {
  table: {
    style: {
      width: "100%",
      borderCollapse: "collapse",
      whiteSpace: "normal",
    },
  },
  tableWrapper: {
    style: { overflowX: "auto" },
  },
  headRow: {
    style: {
      backgroundColor: "var(--bg)",
      borderBottomColor: "var(--border)",
      borderBottomStyle: "solid",
      borderBottomWidth: "1px",
      minHeight: "2.75rem",
    },
  },
  headCells: {
    style: {
      padding: "0.75rem 1rem",
      fontSize: "0.75rem",
      fontWeight: 600,
      color: "var(--muted)",
      whiteSpace: "nowrap",
    },
  },
  rows: {
    style: {
      borderBottomColor: "var(--border)",
      borderBottomStyle: "solid",
      borderBottomWidth: "1px",
      minHeight: "3.5rem",
    },
    stripedStyle: { backgroundColor: "var(--bg)" },
  },
  cells: {
    style: {
      padding: "0.75rem 1rem",
      fontSize: "0.875rem",
      color: "var(--text)",
      lineHeight: 1.4,
    },
  },
  pagination: {
    style: {
      borderTopColor: "var(--border)",
      borderTopStyle: "solid",
      borderTopWidth: "1px",
      color: "var(--text)",
      fontSize: "0.8125rem",
      padding: "0.625rem 1rem",
      flexWrap: "wrap",
      gap: "0.5rem",
    },
    pageButtonsStyle: {
      borderRadius: "6px",
      padding: "0.25rem 0.5rem",
      margin: "0 0.125rem",
      fill: "var(--primary)",
      color: "var(--primary)",
    },
  },
  noData: {
    style: { padding: 0 },
  },
};

export type DataTableProps<T> = {
  columns: TableColumn<T>[];
  data: T[];
  /** Active la pagination client (défaut 10 lignes/page). */
  pagination?: boolean;
  perPage?: number;
  /** Active le tri par colonne (défaut true, géré au niveau colonne). */
  sortable?: boolean;
  /** Active la recherche texte intégrée au-dessus de la table. */
  searchable?: boolean | string[];
  /** Placeholder de l'input de recherche. */
  searchPlaceholder?: string;
  /** Contenu du EmptyState quand data vide. */
  emptyTitle?: string;
  emptyHint?: string;
  /** Clé de comparaison pour striping. */
  striped?: boolean;
  /** Désactive l'enveloppe Card (défaut true). */
  card?: boolean;
  /** Hauteur max avant scroll vertical. */
  maxHeight?: string;
};

export function DataTable<T>({
  columns,
  data,
  pagination = false,
  perPage = 10,
  searchable = false,
  searchPlaceholder = "Rechercher…",
  emptyTitle = "Aucune donnée",
  emptyHint,
  striped = false,
  card = true,
  maxHeight,
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!searchable) return data;
    const q = query.trim().toLowerCase();
    if (!q) return data;
    const fields = Array.isArray(searchable) ? searchable : null;
    return data.filter((row) => {
      if (fields) {
        return fields.some((f) => {
          const v = (row as Record<string, unknown>)?.[f];
          return String(v ?? "").toLowerCase().includes(q);
        });
      }
      return Object.values(row as Record<string, unknown>).some((v) =>
        String(v ?? "").toLowerCase().includes(q),
      );
    });
  }, [data, query, searchable]);

  const wrapper = (children: React.ReactNode) =>
    card ? (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)] overflow-hidden">
        {children}
      </div>
    ) : (
      <div className="overflow-hidden">{children}</div>
    );

  return (
    <div className="space-y-3">
      {searchable ? (
        <div className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow)]">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0 text-[var(--muted)]"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full border-0 bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
          />
        </div>
      ) : null}
      {wrapper(
        <DataTableBase
          columns={columns}
          data={filtered}
          customStyles={customStyles}
          striped={striped}
          pagination={pagination}
          paginationPerPage={perPage}
          paginationRowsPerPageOptions={[10, 25, 50, 100]}
          paginationComponentOptions={{
            rowsPerPageText: "lignes par page :",
            rangeSeparatorText: "sur",
            noRowsPerPage: false,
            selectAllRowsItem: false,
          }}
          fixedHeader={Boolean(maxHeight)}
          fixedHeaderScrollHeight={maxHeight ?? "100%"}
          noDataComponent={
            <EmptyState title={emptyTitle} hint={emptyHint} />
          }
          highlightOnHover
          pointerOnHover
        />,
      )}
    </div>
  );
}

export type { TableColumn } from "react-data-table-component";
