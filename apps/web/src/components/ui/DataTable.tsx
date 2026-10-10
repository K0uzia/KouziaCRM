import { useMemo, useState, type ReactNode } from "react";
import DataTableBase, {
  createTheme,
  type TableColumn,
  type TableProps,
} from "react-data-table-component";
import { EmptyState } from "./Card";

// Thème de la bibliothèque branché sur nos tokens : elle injecte ces couleurs en variables
// CSS en ligne (son thème par défaut met #EEEEEE au survol, illisible sur fond sombre).
createTheme(
  "kouzia",
  {
    text: { primary: "var(--text)", secondary: "var(--muted)", disabled: "rgb(154 161 191 / 0.35)" },
    background: { default: "var(--surface)" },
    context: { background: "var(--primary-soft)", text: "var(--text)" },
    divider: { default: "var(--border)" },
    button: {
      default: "var(--primary)",
      focus: "var(--primary-soft)",
      hover: "var(--surface-hover)",
      disabled: "rgb(154 161 191 / 0.35)",
    },
    selected: { default: "var(--primary-soft)", text: "var(--text)" },
    highlightOnHover: { default: "var(--surface-raised)", text: "var(--text)" },
    striped: { default: "var(--bg-subtle)", text: "var(--text)" },
  },
  "dark",
);

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
      backgroundColor: "var(--bg-subtle)",
      borderBottomColor: "var(--border)",
      borderBottomStyle: "solid",
      borderBottomWidth: "1px",
      minHeight: "2.5rem",
    },
  },
  headCells: {
    style: {
      padding: "0.5rem 1rem",
      fontSize: "0.6875rem",
      fontWeight: 600,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
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
      backgroundColor: "var(--surface)",
    },
    stripedStyle: { backgroundColor: "var(--bg-subtle)" },
    highlightOnHoverStyle: { backgroundColor: "var(--surface-raised)", outline: "none" },
  },
  cells: {
    style: {
      padding: "0.625rem 1rem",
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
      backgroundColor: "var(--surface)",
      color: "var(--muted)",
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
  /** Filtres affichés dans la barre d'outils, à côté de la recherche. */
  toolbar?: ReactNode;
  /** Clic sur une ligne (souris). Garder un lien dans une cellule pour le clavier. */
  onRowClick?: (row: T) => void;
  /** Libellé du compteur (« clients », « factures »). */
  countLabel?: string;
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
  // Colonnes marquées `hide` : secondaires sur petit écran, absentes de la carte.
  const fields = columns.filter((c) => !isActionColumn(c) && !c.hide);
  const actions = columns.filter(isActionColumn);
  const [titleCol, leadCol, ...rest] = fields;

  return (
    // Liens des cellules : cible de 44 px au doigt (ex. numéro de facture des encaissements).
    <article className="min-w-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center">
      <div className="flex min-w-0 items-start justify-between gap-3">
        {titleCol ? (
          <div className="min-w-0 text-sm font-semibold text-[var(--text)]">
            {renderColumnCell(titleCol, row, index)}
          </div>
        ) : null}
        {leadCol ? (
          <div className="min-w-0 shrink-0 text-right text-sm text-[var(--text)]">
            {renderColumnCell(leadCol, row, index)}
          </div>
        ) : null}
      </div>
      {rest.length > 0 ? (
        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2">
          {rest.map((col, i) => {
            const label = columnLabel(col) || `Champ ${i + 1}`;
            return (
              <div key={`${label}-${i}`} className="min-w-0">
                <dt className="text-xs text-[var(--muted)]">{label}</dt>
                <dd className="mt-0.5 min-w-0 truncate text-sm text-[var(--text)]">
                  {renderColumnCell(col, row, index)}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-3 [&_a]:min-h-11 [&_button]:h-auto [&_button]:min-h-11">
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
  maxHeight,
  renderMobileCard,
  toolbar,
  onRowClick,
  countLabel,
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");
  const [mobilePage, setMobilePage] = useState(1);
  // Une colonne à largeur fixe ne prend pas de part de l'espace libre (grow vaut 1 par défaut
  // dans la bibliothèque, ce qui faisait déborder le tableau).
  const sizedColumns = useMemo(
    () => columns.map((c) => (c.width && c.grow === undefined ? { ...c, grow: 0 } : c)),
    [columns],
  );

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
  const hasToolbar = Boolean(searchable || toolbar);

  return (
    <section className="ui-card min-w-0 overflow-hidden">
      {hasToolbar ? (
        <div className="flex flex-col gap-3 border-b border-[var(--border)] p-3 sm:p-4 lg:flex-row lg:items-center">
          {searchable ? (
            <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-input)] bg-[var(--bg-subtle)] px-3 focus-within:border-[var(--primary)] lg:w-80">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden>
                <path
                  fillRule="evenodd"
                  d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="sr-only">{searchPlaceholder}</span>
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMobilePage(1);
                }}
                placeholder={searchPlaceholder}
                className="min-h-11 w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
              />
            </label>
          ) : null}
          {toolbar ? <div className="min-w-0 flex-1">{toolbar}</div> : <div className="hidden flex-1 lg:block" />}
          <p className="shrink-0 text-xs tabular-nums text-[var(--muted)]" aria-live="polite">
            {filtered.length} {countLabel ?? (filtered.length > 1 ? "résultats" : "résultat")}
          </p>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      ) : (
        <>
          <div className="space-y-2 p-3 md:hidden">
            {mobileRows.map((row, index) => {
              const globalIndex = pagination ? (currentMobilePage - 1) * perPage + index : index;
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
              <MobilePager page={currentMobilePage} pageCount={pageCount} onPage={setMobilePage} />
            ) : null}
          </div>

          <div className="ui-table-wrap hidden min-w-0 md:block">
            <DataTableBase
              columns={sizedColumns}
              data={filtered}
              customStyles={customStyles}
              theme="kouzia"
              striped={striped}
              pagination={pagination && filtered.length > perPage}
              paginationPerPage={perPage}
              paginationRowsPerPageOptions={[10, 25, 50, 100]}
              paginationComponentOptions={{
                rowsPerPageText: "Lignes par page :",
                rangeSeparatorText: "sur",
                noRowsPerPage: false,
                selectAllRowsItem: false,
              }}
              fixedHeader={Boolean(maxHeight)}
              fixedHeaderScrollHeight={maxHeight ?? "100%"}
              noDataComponent={<EmptyState title={emptyTitle} hint={emptyHint} />}
              highlightOnHover
              pointerOnHover={Boolean(onRowClick)}
              onRowClicked={onRowClick ? (row) => onRowClick(row) : undefined}
            />
          </div>
        </>
      )}
    </section>
  );
}

export type { TableColumn } from "react-data-table-component";
