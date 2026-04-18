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
import { MissingFieldsRow } from "@/components/field-status-pill";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

const ROW_HEIGHT = 52;

function truncate(s: string | null | undefined, n = 60): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function joinList(xs: readonly string[] | undefined, max = 3): string {
  if (!xs || xs.length === 0) return "";
  return xs.slice(0, max).join(", ") + (xs.length > max ? `, +${xs.length - max}` : "");
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

export function RowTable({ rows }: { rows: Row[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "completeness_score", desc: false },
  ]);
  const [filter, setFilter] = useState("");

  const data = useMemo(() => rows, [rows]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
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

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Input
          placeholder="Filter by name, firm, country…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-xs text-muted-foreground">
          {virtualRows.length} of {rows.length} rows
        </span>
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
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const row = virtualRows[vRow.index];
            return (
              <div
                key={row.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                  height: vRow.size,
                }}
                className="flex border-b hover:bg-muted/40"
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
    </div>
  );
}
