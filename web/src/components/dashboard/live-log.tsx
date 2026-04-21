"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import type { Row, Step } from "@/lib/firestore/schema";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString([], { hour12: false });
}

function fmtCents(c: number): string {
  if (c <= 0) return "";
  if (c < 100) return `${c}¢`;
  return `$${(c / 100).toFixed(2)}`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: Step["status"]): string {
  switch (status) {
    case "done": return "text-emerald-500";
    case "error": return "text-red-500";
    case "skipped": return "text-amber-500";
    case "running": return "text-sky-500";
  }
}

export function LiveLog({
  steps,
  rows,
  onSelectRow,
}: {
  steps: Step[];
  rows: Row[];
  onSelectRow?: (row: Row) => void;
}) {
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.id, r.name ?? r.firm_name ?? `row ${r.id}`);
    return m;
  }, [rows]);
  const rowById = useMemo(() => {
    const m = new Map<string, Row>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickTop, setStickTop] = useState(true);
  const [copied, setCopied] = useState(false);

  // Unique rowIds in log order (newest first), deduped. Used by "copy all" so
  // the clipboard list matches the order of what's on screen.
  const uniqueRowIds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of steps) {
      if (seen.has(s.row_id)) continue;
      seen.add(s.row_id);
      out.push(s.row_id);
    }
    return out;
  }, [steps]);

  async function copyAll() {
    const lines = uniqueRowIds.map((id) => {
      const name = nameById.get(id);
      return name ? `${id}\t${name}` : id;
    });
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      toast.success(`Copied ${lines.length} investor id${lines.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  // Auto-scroll to top (newest) when a new step arrives, only if user is at
  // the top already. If they've scrolled down to read history, don't yank.
  useEffect(() => {
    if (!stickTop) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [steps, stickTop]);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Live log
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{steps.length} recent</span>
          <button
            type="button"
            onClick={copyAll}
            disabled={uniqueRowIds.length === 0}
            title={`Copy ${uniqueRowIds.length} unique investor id${uniqueRowIds.length === 1 ? "" : "s"} (tab-separated with name)`}
            aria-label="Copy all investor ids"
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? (
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => setStickTop((e.currentTarget as HTMLDivElement).scrollTop <= 4)}
        className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-tight"
      >
        {steps.length === 0 ? (
          <div className="p-3 text-muted-foreground">waiting for steps…</div>
        ) : (
          <ul className="divide-y divide-border/50">
            {steps.map((s) => {
              const row = rowById.get(s.row_id);
              const clickable = row && onSelectRow;
              return (
              <li
                key={`${s.row_id}:${s.idx}`}
                onClick={clickable ? () => onSelectRow!(row!) : undefined}
                className={`flex gap-2 px-3 py-1 ${clickable ? "cursor-pointer hover:bg-muted/50" : ""}`}
                title={clickable ? "Open row detail" : undefined}
              >
                <span className="shrink-0 text-muted-foreground">{fmtTime(s.finished_at ?? s.started_at)}</span>
                <span className="shrink-0 font-mono text-muted-foreground/60" title={`row id ${s.row_id}`}>
                  {s.row_id}
                </span>
                <span className="shrink-0 truncate max-w-[9rem]" title={nameById.get(s.row_id) ?? s.row_id}>
                  {nameById.get(s.row_id) ?? s.row_id}
                </span>
                <span className="text-muted-foreground">›</span>
                <span className="shrink-0 truncate max-w-[7rem]">{s.chosen_tool ?? "stop"}</span>
                <span className={`shrink-0 ${statusColor(s.status)}`}>{s.status}</span>
                <span className="shrink-0 text-muted-foreground">{fmtCents(s.tool_cost_cents ?? 0)}</span>
                <span
                  className="shrink-0 text-muted-foreground/70"
                  title={
                    s.timings
                      ? `decide ${fmtMs(s.timings.decide_ms) || "—"} · tool ${fmtMs(s.timings.tool_ms) || "—"} · extract ${fmtMs(s.timings.extract_ms) || "—"}`
                      : undefined
                  }
                >
                  {fmtMs(s.timings?.total_ms)}
                </span>
                {s.status === "error" && s.error_message && (
                  <span className="truncate text-red-400" title={s.error_message}>
                    {s.error_message}
                  </span>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
