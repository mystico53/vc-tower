"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { Row } from "@/lib/firestore/schema";
import { InvestorType, CanonicalStage } from "@/lib/firestore/schema";
import type { RowFilters } from "@/lib/firestore/useRows";
import { MissingFieldsRow } from "@/components/field-status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RowDetailDrawer } from "@/components/row-detail-drawer";

const ROW_HEIGHT = 52;

function truncate(s: string | null | undefined, n = 60): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function joinList(xs: readonly string[] | undefined, max = 3): string {
  if (!xs || xs.length === 0) return "";
  return xs.slice(0, max).join(", ") + (xs.length > max ? `, +${xs.length - max}` : "");
}

function scrapeStatusBadge(row: Row) {
  const status = row.scrape_status ?? null;
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  const label =
    status === "complete" ? "complete" :
    status === "dead_site" ? "dead site" :
    status === "error_only" ? "error" :
    "partial";
  const className =
    status === "complete"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : status === "dead_site"
      ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
      : status === "error_only"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
      : "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30";
  const reason = row.scrape_status_reason ?? null;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium ${className}`}
      >
        {label}
      </span>
      {reason && (
        <span className="text-[10px] text-muted-foreground" title={reason}>
          {reason}
        </span>
      )}
    </div>
  );
}

const columns: ColumnDef<Row>[] = [
  {
    accessorKey: "completeness_score",
    header: "Score",
    size: 70,
    cell: (c) => {
      const v = c.getValue<number>() ?? 0;
      return (
        <Badge variant={v >= 70 ? "default" : v >= 40 ? "secondary" : "outline"}>
          {v}
        </Badge>
      );
    },
  },
  {
    accessorKey: "scrape_status",
    header: "Status",
    size: 110,
    cell: (c) => scrapeStatusBadge(c.row.original),
  },
  {
    accessorKey: "name",
    header: "Name",
    size: 220,
    cell: (c) => (
      <div className="flex flex-col">
        <span className="font-medium">{truncate(c.row.original.name, 40)}</span>
        <span className="text-xs text-muted-foreground">
          {c.row.original.firm_name && c.row.original.firm_name !== c.row.original.name
            ? c.row.original.firm_name
            : c.row.original.investor_type}
        </span>
      </div>
    ),
  },
  {
    accessorKey: "investor_type",
    header: "Type",
    size: 110,
  },
  {
    accessorKey: "hq_country",
    header: "HQ",
    size: 60,
  },
  {
    accessorKey: "sectors_l1",
    header: "Sectors",
    size: 180,
    cell: (c) => joinList(c.row.original.sectors_l1),
  },
  {
    accessorKey: "stages",
    header: "Stages",
    size: 160,
    cell: (c) => joinList(c.row.original.stages),
  },
  {
    accessorKey: "check_min_usd",
    header: "Check",
    size: 140,
    cell: (c) => {
      const r = c.row.original;
      if (r.check_min_usd == null && r.check_max_usd == null) return "";
      const fmt = (n: number) =>
        n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` :
        n >= 1_000 ? `$${Math.round(n / 1_000)}k` : `$${n}`;
      if (r.check_min_usd != null && r.check_max_usd != null) {
        return `${fmt(r.check_min_usd)}–${fmt(r.check_max_usd)}`;
      }
      return fmt(r.check_min_usd ?? r.check_max_usd ?? 0);
    },
  },
  {
    id: "missing_fields",
    header: "Missing",
    size: 280,
    cell: (c) => <MissingFieldsRow missing={c.row.original.missing_fields} />,
  },
];

type RowTableProps = {
  rows: Row[];
  filters: RowFilters;
  onFiltersChange: (f: RowFilters) => void;
  hasQuery: boolean;
  loading: boolean;
  onRefresh: () => void;
};

export function RowTable({
  rows,
  filters,
  onFiltersChange,
  hasQuery,
  loading,
  onRefresh,
}: RowTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "completeness_score", desc: false },
  ]);
  const [selectedRow, setSelectedRow] = useState<Row | null>(null);
  // Draft filter state — edits here don't query until Run is clicked.
  const [draft, setDraft] = useState<RowFilters>(filters);
  const draftDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(filters),
    [draft, filters],
  );
  const draftActive =
    !!draft.investorType ||
    !!(draft.country && draft.country.trim()) ||
    !!draft.stage ||
    !!(draft.sector && draft.sector.trim()) ||
    typeof draft.minScore === "number" ||
    typeof draft.maxScore === "number" ||
    !!(draft.search && draft.search.trim());
  const searchValue = draft.search ?? "";

  const data = useMemo(() => rows, [rows]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: searchValue },
    onSortingChange: setSorting,
    onGlobalFilterChange: (updater) => {
      const next =
        typeof updater === "function"
          ? (updater as (old: string) => string)(searchValue)
          : updater;
      setDraft((d) => ({ ...d, search: String(next ?? "") }));
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _colId, value) => {
      const q = String(value).toLowerCase();
      if (!q) return true;
      const r = row.original;
      return [r.name, r.firm_name, r.hq_country, r.investor_type, r.website, r.linkedin]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q));
    },
    getRowId: (r) => r.id,
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualRows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const patch = (p: Partial<RowFilters>) => setDraft((d) => ({ ...d, ...p }));
  const run = () => {
    onFiltersChange(draft);
    onRefresh();
  };
  const clearAll = () => {
    const empty = { max: draft.max ?? 200 } as RowFilters;
    setDraft(empty);
    onFiltersChange(empty);
  };

  const selectCls =
    "h-8 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        <select
          aria-label="Investor type"
          className={selectCls}
          value={draft.investorType ?? ""}
          onChange={(e) =>
            patch({
              investorType: e.target.value
                ? (e.target.value as RowFilters["investorType"])
                : undefined,
            })
          }
        >
          <option value="">Any type</option>
          {InvestorType.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <Input
          aria-label="Country"
          placeholder="HQ (e.g. US)"
          value={draft.country ?? ""}
          onChange={(e) => patch({ country: e.target.value })}
          className="h-8 w-24"
          maxLength={4}
        />

        <select
          aria-label="Stage"
          className={selectCls}
          value={draft.stage ?? ""}
          onChange={(e) =>
            patch({
              stage: e.target.value
                ? (e.target.value as RowFilters["stage"])
                : undefined,
            })
          }
        >
          <option value="">Any stage</option>
          {CanonicalStage.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <Input
          aria-label="Sector (L1)"
          placeholder="Sector (L1)"
          value={draft.sector ?? ""}
          onChange={(e) => patch({ sector: e.target.value })}
          className="h-8 w-36"
        />

        <select
          aria-label="Score range"
          className={selectCls}
          value={
            typeof draft.minScore === "number" ||
            typeof draft.maxScore === "number"
              ? `${draft.minScore ?? ""}-${draft.maxScore ?? ""}`
              : ""
          }
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              patch({ minScore: undefined, maxScore: undefined });
              return;
            }
            const [lo, hi] = v.split("-");
            patch({
              minScore: lo === "" ? undefined : Number(lo),
              maxScore: hi === "" ? undefined : Number(hi),
            });
          }}
        >
          <option value="">Any score</option>
          <option value="0-20">0–20</option>
          <option value="20-40">20–40</option>
          <option value="40-60">40–60</option>
          <option value="60-80">60–80</option>
          <option value="80-">80+</option>
        </select>

        <select
          aria-label="Max results"
          className={selectCls}
          value={draft.max ?? 200}
          onChange={(e) => patch({ max: Number(e.target.value) })}
        >
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
        </select>

        <Button
          size="sm"
          onClick={run}
          disabled={loading || (!draftActive && !hasQuery)}
        >
          {loading ? "Loading…" : draftDirty || !hasQuery ? "Run" : "Refresh"}
        </Button>
        <Button size="sm" variant="ghost" onClick={clearAll}>
          Clear
        </Button>

        <span className="ml-auto text-xs text-muted-foreground">
          {hasQuery
            ? filters.search?.trim() &&
              !filters.investorType &&
              !filters.country?.trim() &&
              !filters.stage &&
              !filters.sector?.trim() &&
              typeof filters.minScore !== "number" &&
              typeof filters.maxScore !== "number"
              ? `${virtualRows.length} of ${rows.length} matched (full scan)`
              : `${virtualRows.length} of ${rows.length} loaded (cap ${filters.max ?? 200})`
            : "no query"}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="Search by name, firm, country…"
          value={searchValue}
          onChange={(e) => patch({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (draftDirty || !hasQuery) && draftActive) {
              run();
            }
          }}
          className="max-w-sm"
        />
      </div>

      <div
        ref={parentRef}
        className="relative flex-1 overflow-auto rounded-md border bg-card"
      >
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <colgroup>
            {table.getHeaderGroups()[0]?.headers.map((h) => (
              <col key={h.id} style={{ width: h.getSize() }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-muted/70 backdrop-blur">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className="cursor-pointer select-none px-3 py-2 text-left font-medium"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{
                      asc: " ↑",
                      desc: " ↓",
                    }[header.column.getIsSorted() as string] ?? ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
        </table>
        {!hasQuery && (
          <div className="flex h-full min-h-[240px] items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Pick a filter above, then Refresh to load investors.
          </div>
        )}
        {hasQuery && loading && (
          <div className="flex h-full min-h-[240px] items-center justify-center p-10 text-sm text-muted-foreground">
            Loading rows…
          </div>
        )}
        {hasQuery && !loading && rows.length === 0 && (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <span>No matches for these filters.</span>
            <Button size="sm" variant="outline" onClick={clearAll}>
              Clear filters
            </Button>
          </div>
        )}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
            display: hasQuery && !loading && rows.length > 0 ? "block" : "none",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const row = virtualRows[vRow.index];
            return (
              <div
                key={row.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedRow(row.original)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedRow(row.original);
                  }
                }}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                  height: vRow.size,
                }}
                className="flex cursor-pointer border-b outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    className="flex items-center overflow-hidden px-3 py-2"
                    style={{ width: cell.column.getSize(), flex: "none" }}
                  >
                    <div className="w-full truncate">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <RowDetailDrawer
        row={selectedRow}
        open={selectedRow !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedRow(null);
        }}
        devMode={process.env.NODE_ENV !== "production"}
      />
    </div>
  );
}
