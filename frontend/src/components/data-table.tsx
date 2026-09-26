"use client";

import { useCallback, useEffect, useState } from "react";

export interface Column<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
  className?: string;
}

export interface Page<T> {
  total: number;
  items: T[];
}

export function DataTable<T>({
  columns,
  fetchPage,
  rowKey,
  searchable = true,
  searchPlaceholder = "Rechercher…",
  pageSizeOptions = [25, 50, 100],
  toolbar,
  emptyMessage = "Aucun résultat.",
  refreshKey = 0,
  onRowClick,
}: {
  columns: Column<T>[];
  fetchPage: (p: { offset: number; limit: number; q: string }) => Promise<Page<T>>;
  rowKey: (row: T, i: number) => string | number;
  searchable?: boolean;
  searchPlaceholder?: string;
  pageSizeOptions?: number[];
  toolbar?: React.ReactNode;
  emptyMessage?: string;
  refreshKey?: number;
  onRowClick?: (row: T) => void;
}) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(pageSizeOptions[0]);
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Revenir à la 1re page quand la recherche, la taille ou les filtres changent.
  useEffect(() => {
    setPage(0);
  }, [debouncedQ, pageSize, fetchPage]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPage({ offset: page * pageSize, limit: pageSize, q: debouncedQ });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, page, pageSize, debouncedQ]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <div className="rounded-xl border border-line bg-surface">
      {/* Barre d'outils */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        {toolbar}
        {searchable && (
          <div className="relative ml-auto">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">⌕</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-56 rounded-lg border border-line bg-surface-2 py-2 pl-8 pr-3 text-sm outline-none transition focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
        )}
      </div>

      {error && (
        <p className="border-b border-critical/30 bg-critical/10 px-4 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              {columns.map((c, i) => (
                <th key={i} className={`px-4 py-2.5 font-medium ${c.className ?? ""}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-muted">
                  {loading ? "Chargement…" : emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-b border-line/50 transition hover:bg-surface-2 ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                >
                  {columns.map((c, j) => (
                    <td key={j} className={`px-4 py-2.5 ${c.className ?? ""}`}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-3 text-sm">
        <span className="text-muted">
          {from}–{to} sur <span className="font-medium text-foreground">{total}</span>
        </span>
        <div className="flex items-center gap-2">
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
          >
            {pageSizeOptions.map((s) => (
              <option key={s} value={s}>{s} / page</option>
            ))}
          </select>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page <= 0}
            className="rounded-lg border border-line px-3 py-1.5 transition hover:border-accent/60 hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
          >
            ‹ Préc.
          </button>
          <span className="tabular-nums text-muted">
            {page + 1} / {maxPage + 1}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            disabled={page >= maxPage}
            className="rounded-lg border border-line px-3 py-1.5 transition hover:border-accent/60 hover:text-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
          >
            Suiv. ›
          </button>
        </div>
      </div>
    </div>
  );
}
