"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Row } from "@/lib/firestore/schema";

type CellState =
  | { kind: "untouched" }
  | { kind: "error" }
  | { kind: "incomplete" }
  | { kind: "stuck" }          // hit STEP_MAX_PER_ROW with missing_fields still pending
  | { kind: "dead_letter" }    // empty-batch streak exceeded; skipped by play pool
  | { kind: "progress"; score: number };

function cellStateFor(row: Row): CellState {
  if (row.scrape_status === "dead_letter") return { kind: "dead_letter" };
  if (row.scrape_status === "error_only") return { kind: "error" };
  if (row.scrape_status === "stuck_at_cap") return { kind: "stuck" };
  if (row.scrape_status === "dead_site") return { kind: "incomplete" };
  if (row.scrape_status === "complete") return { kind: "progress", score: 100 };
  if ((row.total_steps ?? 0) === 0 && !row.last_enriched_at) {
    return { kind: "untouched" };
  }
  // partial or null-with-some-steps: gradient on completeness_score.
  return { kind: "progress", score: Math.max(0, Math.min(100, row.completeness_score ?? 0)) };
}

function textColorFor(state: CellState): string {
  switch (state.kind) {
    case "untouched":
      return "rgba(0,0,0,0.35)";
    case "incomplete":
    case "stuck":
      return "rgba(0,0,0,0.4)";
    case "error":
    case "dead_letter":
      return "rgba(255,255,255,0.65)";
    case "progress": {
      const l = 96 - 76 * (state.score / 100);
      return l > 55 ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.65)";
    }
  }
}

function fillFor(state: CellState): string {
  switch (state.kind) {
    case "untouched":
      return "#e5e7eb";
    case "error":
      return "#dc2626";
    case "incomplete":
      return "#facc15";
    case "stuck":
      // amber — deliberately between yellow (incomplete/dead-site) and red
      // (error_only). "Stuck" is different from "error" because the row has
      // real progress; different from "incomplete" because there's a
      // concrete unblock action (reset or bump the cap).
      return "#f97316";
    case "dead_letter":
      // gray — "we're done trying." Visually recedes from the grid so the
      // operator's eye skips to live rows. The row is skipped by the play
      // pool so running steps on it requires manual reset.
      return "#6b7280";
    case "progress": {
      // HSL interp: near-white at 0, dark green at 100.
      // At score=0 we still want a whisper of green to show the row is live.
      const t = state.score / 100;
      const h = 140;
      const s = 15 + 55 * t; // 15 → 70
      const l = 96 - 76 * t; // 96 → 20
      return `hsl(${h} ${s}% ${l}%)`;
    }
  }
}

const COLS = 100;

type Geometry = {
  cellW: number;
  cellH: number;
  gap: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
};

function computeGeometry(container: { width: number; height: number }, cellCount: number): Geometry {
  const cols = COLS;
  const rows = Math.max(1, Math.ceil(cellCount / cols));
  const gap = 1;
  const cellW = Math.max(2, Math.floor((container.width - (cols - 1) * gap) / cols));
  const cellH = Math.max(2, Math.floor((container.height - (rows - 1) * gap) / rows));
  const width = cols * cellW + (cols - 1) * gap;
  const height = rows * cellH + (rows - 1) * gap;
  return { cellW, cellH, gap, cols, rows, width, height };
}

function cellXY(index: number, g: Geometry): { x: number; y: number } {
  const c = index % g.cols;
  const r = Math.floor(index / g.cols);
  return { x: c * (g.cellW + g.gap), y: r * (g.cellH + g.gap) };
}

function indexAt(px: number, py: number, g: Geometry, cellCount: number): number | null {
  const c = Math.floor(px / (g.cellW + g.gap));
  const r = Math.floor(py / (g.cellH + g.gap));
  if (c < 0 || c >= g.cols || r < 0) return null;
  // bail if inside the inter-cell gap
  const localX = px - c * (g.cellW + g.gap);
  const localY = py - r * (g.cellH + g.gap);
  if (localX >= g.cellW || localY >= g.cellH) return null;
  const idx = r * g.cols + c;
  if (idx >= cellCount) return null;
  return idx;
}

export function ScrapeGrid({
  rows,
  runningRowIds,
  onSelect,
  headerActions,
}: {
  rows: Row[];
  runningRowIds: Set<string>;
  onSelect: (row: Row) => void;
  headerActions?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [hover, setHover] = useState<{ index: number; clientX: number; clientY: number } | null>(null);

  // Display order: ascending by numeric id, so cell position is stable and
  // matches the SQLite row id (1 → top-left, then left-to-right, top-to-bottom).
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const ai = Number(a.id);
      const bi = Number(b.id);
      if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [rows]);

  // Rebuild geometry on container resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setGeom(computeGeometry({ width: rect.width, height: rect.height }, sortedRows.length));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sortedRows.length]);

  // Keep a ref to current running ids so the RAF loop reads the latest set
  // without re-binding. Same for rows.
  const runningRef = useRef(runningRowIds);
  const rowsRef = useRef(sortedRows);
  const hoverRef = useRef<number | null>(null);
  useEffect(() => { runningRef.current = runningRowIds; }, [runningRowIds]);
  useEffect(() => { rowsRef.current = sortedRows; }, [sortedRows]);
  useEffect(() => { hoverRef.current = hover?.index ?? null; }, [hover]);

  // Draw loop. Runs at ~20fps so the orange active-cell outline can pulse.
  useEffect(() => {
    if (!geom) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(geom.width * dpr);
    canvas.height = Math.round(geom.height * dpr);
    canvas.style.width = `${geom.width}px`;
    canvas.style.height = `${geom.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let last = 0;
    const draw = (ts: number) => {
      if (ts - last < 50) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = ts;
      ctx.clearRect(0, 0, geom.width, geom.height);
      const currentRows = rowsRef.current;
      const running = runningRef.current;
      // Fill
      for (let i = 0; i < currentRows.length; i++) {
        const { x, y } = cellXY(i, geom);
        ctx.fillStyle = fillFor(cellStateFor(currentRows[i]));
        ctx.fillRect(x, y, geom.cellW, geom.cellH);
      }
      // Row id labels, rotated -90° (read bottom-to-top). Only drawn when
      // the cell is tall/wide enough that the text is legible.
      const canShowIds = geom.cellW >= 8 && geom.cellH >= 16;
      if (canShowIds) {
        ctx.save();
        ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let i = 0; i < currentRows.length; i++) {
          const row = currentRows[i];
          const state = cellStateFor(row);
          const { x, y } = cellXY(i, geom);
          ctx.fillStyle = textColorFor(state);
          ctx.save();
          ctx.translate(x + geom.cellW / 2, y + geom.cellH - 2);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(row.id, 0, 0);
          ctx.restore();
        }
        ctx.restore();
      }
      // Pulse stroke for running
      if (running.size > 0) {
        const phase = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(ts / 200));
        ctx.strokeStyle = `rgba(249, 115, 22, ${phase.toFixed(3)})`;
        ctx.lineWidth = 1;
        for (let i = 0; i < currentRows.length; i++) {
          if (!running.has(currentRows[i].id)) continue;
          const { x, y } = cellXY(i, geom);
          ctx.strokeRect(x + 0.5, y + 0.5, geom.cellW - 1, geom.cellH - 1);
        }
      }
      // Hover highlight: inflate the cell and repaint in an accent color so
      // it visibly "lifts" off the grid. Drawn last so it overlaps neighbors.
      const hoverIdx = hoverRef.current;
      if (hoverIdx != null && hoverIdx < currentRows.length) {
        const row = currentRows[hoverIdx];
        const { x, y } = cellXY(hoverIdx, geom);
        const grow = 4;
        const hx = x - grow;
        const hy = y - grow;
        const hw = geom.cellW + grow * 2;
        const hh = geom.cellH + grow * 2;
        ctx.fillStyle = "#3b82f6"; // blue-500 accent
        ctx.fillRect(hx, hy, hw, hh);
        ctx.strokeStyle = "rgba(15,23,42,0.95)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hx + 0.75, hy + 0.75, hw - 1.5, hh - 1.5);
        // redraw the id label larger and white on the accent fill
        ctx.save();
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.translate(hx + hw / 2, hy + hh - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(row.id, 0, 0);
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [geom]);

  const hoveredRow = useMemo(() => {
    if (!hover) return null;
    return sortedRows[hover.index] ?? null;
  }, [hover, sortedRows]);

  const legend = (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <LegendSwatch color="#e5e7eb" label="untouched" border />
      <LegendSwatch color="hsl(140 40% 60%)" label="in progress" />
      <LegendSwatch color="hsl(140 70% 20%)" label="complete" />
      <LegendSwatch color="#facc15" label="incomplete" />
      <LegendSwatch color="#f97316" label="stuck" />
      <LegendSwatch color="#6b7280" label="dead letter" />
      <LegendSwatch color="#dc2626" label="error" />
      <span className="ml-2 inline-flex items-center gap-1">
        <span className="h-2.5 w-2.5 rounded-sm border border-orange-500" />
        running
      </span>
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            {rows.length.toLocaleString()} rows · {runningRowIds.size} running
          </div>
          {headerActions}
        </div>
        {legend}
      </div>
      <div ref={containerRef} className="relative flex-1 overflow-hidden rounded-sm border border-muted-foreground/30 bg-muted/20">
        {geom && (
          <canvas
            ref={canvasRef}
            className="block cursor-pointer"
            onMouseMove={(e) => {
              const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
              const idx = indexAt(e.clientX - rect.left, e.clientY - rect.top, geom, sortedRows.length);
              if (idx == null) setHover(null);
              else setHover({ index: idx, clientX: e.clientX, clientY: e.clientY });
            }}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
              const idx = indexAt(e.clientX - rect.left, e.clientY - rect.top, geom, sortedRows.length);
              if (idx == null) return;
              const row = sortedRows[idx];
              if (row) onSelect(row);
            }}
          />
        )}
        {hoveredRow && hover && (
          <CellTooltip row={hoveredRow} clientX={hover.clientX} clientY={hover.clientY} />
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label, border = false }: { color: string; label: string; border?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="h-2.5 w-2.5 rounded-sm"
        style={{ background: color, outline: border ? "1px solid var(--border)" : undefined }}
      />
      {label}
    </span>
  );
}

function CellTooltip({ row, clientX, clientY }: { row: Row; clientX: number; clientY: number }) {
  const state = cellStateFor(row);
  const stateLabel =
    state.kind === "untouched" ? "untouched" :
    state.kind === "error" ? "error" :
    state.kind === "stuck" ? "stuck at cap" :
    state.kind === "dead_letter" ? "dead letter" :
    state.kind === "incomplete" ? "incomplete" :
    `score ${Math.round(state.score)}`;
  return (
    <div
      className="pointer-events-none fixed z-10 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md"
      style={{ left: clientX + 12, top: clientY + 12, maxWidth: 260 }}
    >
      <div className="font-medium">{row.name ?? row.firm_name ?? "(unnamed)"}</div>
      <div className="text-muted-foreground">
        {stateLabel} · {row.total_steps ?? 0} steps
        {row.scrape_status_reason ? ` · ${row.scrape_status_reason}` : ""}
      </div>
      {row.missing_fields.length > 0 && (
        <div className="text-muted-foreground">missing: {row.missing_fields.join(", ")}</div>
      )}
    </div>
  );
}
