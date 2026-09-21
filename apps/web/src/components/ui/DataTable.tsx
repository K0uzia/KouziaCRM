import { useMemo, useState, type ReactNode } from "react";
import DataTableBase, {
  type TableColumn,
  type TableProps,
} from "react-data-table-component";
import { EmptyState } from "./Card";

const customStyles: TableProps<never>["customStyles"] = {
  table: {
    style: {
      width: "100%",
      tableLayout: "fixed",
    },
  },
  tableWrapper: {
    style: {
      width: "100%",
      overflowX: "auto",
    },
  },
  headRow: {
    style: {
      backgroundColor: "var(--surface-raised)",
      borderBottomColor: "var(--border)",
      borderBottomStyle: "solid",
      borderBottomWidth: "1px",
      minHeight: "2.75rem",
    },
  },
  headCells: {
    style: {
      padding: "0.75rem 1rem",
      fontSize: "0.8125rem",
      fontWeight: 500,
      color: "var(--muted)",
      whiteSpace: "nowrap",
    },
  },
  rows: {
    style: {
      borderBottomColor: "var(--border)",
      borderBottomStyle: "solid",
      borderBottomWidth: "1px",
      minHeight: "3.25rem",
      backgroundColor: "var(--surface-raised)",
    },
    stripedStyle: { backgroundColor: "var(--surface-hover)" },
    highlightOnHoverStyle: { backgroundColor: "var(--surface-hover)" },
  },
  cells: {
    style: {
      padding: "0.625rem 0.875rem",
      fontSize: "0.875rem",
      color: "var(--text)",
      lineHeight: 1.5,
      overflow: "hidden",
      textOverflow: "ellipsis",
      wordBreak: "break-word",
      backgroundColor: "inherit",
    },
  },
  pagination: {
    style: {
      borderTopColor: "var(--border)",
      borderTopStyle: "solid",
      borderTopWidth: "1px",
      backgroundColor: "var(--surface-raised)",
      color: "var(--text)",
      fontSize: "0.8125rem",
      padding: "0.625rem 1rem",
      flexWrap: "wrap",
      gap: "0.5rem",
      minHeight: "3.5rem",
    },
    pageButtonsStyle: {
      borderRadius: "10px",
      padding: "0.5rem",
      margin: "0 0.125rem",
      minHeight: "44px",
      minWidth: "44px",
      fill: "var(--primary)",
      color: "var(--primary)",
    },
  },
  noData: {
    style: {
      padding: 0,
      backgroundColor: "transparent",
      color: "var(--text)",
    },
  },
};

export type DataTableProps<T> = {
  columns: TableColumn<T>[];
  data: T[];
  pagination?: boolean;
  perPage?: number;
  sortable?: boolean;
  searchable?: boolean | string[];
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  striped?: boolean;
  card?: boolean;
  maxHeight?: string;
  renderMobileCard?: (row: T, index: number) => ReactNode;
};

function columnLabel<T>(col: TableColumn<T>): string {
  if (typeof col.name === "string") return col.name;
  return "";
}

function isActionColumn<T>(col: TableColumn<T>): boolean {
  return Boolean(col.button) || columnLabel(col) === "";
}

function renderColumnCell<T>(col: TableColumn<T>, row: T, index: number): ReactNode {
  if (col.cell) return col.cell(row, index, col, index);
  if (typeof col.selector === "function") {
    const value = col.selector(row, index);
    if (value == null || value === "") return "-";
    return String(value);
  }
  return null;
}

function DefaultMobileCard<T>({
  row,
  index,
  columns,
}: {
  row: T;
  index: number;
  columns: TableColumn<T>[];
}) {
  const fields = columns.filter((c) => !isActionColumn(c));
  const actions = columns.filter(isActionColumn);
  const titleCol = fields[0];
  const rest = fields.slice(1);

  return (
    <article className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-glass)] p-4 shadow-[var(--shadow-card)]">
      {titleCol ? (
        <div className="min-w-0 text-sm font-semibold text-[var(--text)]">
          {renderColumnCell(titleCol, row, index)}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <dl className="mt-3 grid gap-2">
          {rest.map((col, i) => {
            const label = columnLabel(col) || `Champ ${i + 1}`;
            return (
              <div key={`${label}-${i}`} className="min-w-0">
                <dt className="text-xs text-[var(--muted)]">{label}</dt>
                <dd className="mt-0.5 min-w-0 break-words text-sm text-[var(--text)]">
                  {renderColumnCell(col, row, index)}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2 [&_button]:h-auto [&_button]:min-h-11">
          {actions.map((col, i) => (
            <div key={i} className="min-w-0">
              {renderColumnCell(col, row, index)}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function MobilePager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <button
        type="button"
        className="inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 text-sm disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        aria-label="Page précédente"
      >
        Préc.
      </button>
      <span className="text-sm tabular-nums text-[var(--muted)]">
        {page} / {pageCount}
      </span>
      <button
        type="button"
        className="inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 text-sm disabled:opacity-40"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
        aria-label="Page suivante"
      >
        Suiv.
      </button>
    </div>
  );
}

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
  renderMobileCard,
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");
  const [mobilePage, setMobilePage] = useState(1);

  const filtered = useMemo(() => {
    if (!searchable) return data;
    const q = query.trim().toLowerCase();
    if (!q) return data;

    function readPath(row: unknown, path: string): unknown {
      return path.split(".").reduce<unknown>((acc, key) => {
        if (acc == null || typeof acc !== "object") return undefined;
        return (acc as Record<string, unknown>)[key];
      }, row);
    }

    const fields = Array.isArray(searchable) ? searchable : null;
    return data.filter((row) => {
      if (fields) {
        return fields.some((f) => String(readPath(row, f) ?? "").toLowerCase().includes(q));
      }
      return Object.values(row as Record<string, unknown>).some((v) => {
        if (v != null && typeof v === "object") {
          return Object.values(v as Record<string, unknown>).some((nested) =>
            String(nested ?? "").toLowerCase().includes(q),
          );
        }
        return String(v ?? "").toLowerCase().includes(q);
      });
    });
  }, [data, query, searchable]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const currentMobilePage = Math.min(mobilePage, pageCount);
  const mobileRows = pagination
    ? filtered.slice((currentMobilePage - 1) * perPage, currentMobilePage * perPage)
    : filtered;

  const wrapper = (children: React.ReactNode) =>
    card ? (
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-glass)] shadow-[var(--shadow-card)] backdrop-blur-md">
        {children}
      </div>
    ) : (
      <div className="overflow-hidden">{children}</div>
    );

  return (
    <div className="min-w-0 space-y-3">
      {searchable ? (
        <div className="flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0 text-[var(--muted)]"
            aria-hidden
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
            onChange={(e) => {
              setQuery(e.target.value);
              setMobilePage(1);
            }}
            placeholder={searchPlaceholder}
            className="min-h-11 w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
            aria-label={searchPlaceholder}
          />
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-glass)]">
          <EmptyState title={emptyTitle} hint={emptyHint} />
        </div>
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {mobileRows.map((row, index) => {
              const globalIndex = pagination
                ? (currentMobilePage - 1) * perPage + index
                : index;
              const key =
                row && typeof row === "object" && "id" in row
                  ? String((row as { id: unknown }).id)
                  : String(globalIndex);
              return (
                <div key={key}>
                  {renderMobileCard ? (
                    renderMobileCard(row, globalIndex)
                  ) : (
                    <DefaultMobileCard row={row} index={globalIndex} columns={columns} />
                  )}
                </div>
              );
            })}
            {pagination ? (
              <MobilePager
                page={currentMobilePage}
                pageCount={pageCount}
                onPage={setMobilePage}
              />
            ) : null}
          </div>

          <div className="ui-table-wrap hidden min-w-0 md:block">
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
                noDataComponent={<EmptyState title={emptyTitle} hint={emptyHint} />}
                highlightOnHover
                pointerOnHover
              />,
            )}
          </div>
        </>
      )}
    </div>
  );
}

export type { TableColumn } from "react-data-table-component";
