"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
}: {
  steps: Step[];
  rows: Row[];
}) {
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.id, r.name ?? r.firm_name ?? `row ${r.id}`);
    return m;
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickTop, setStickTop] = useState(true);

  // Auto-scroll to top (newest) when a new step arrives, only if user is at
  // the top already. If they've scrolled down to read history, don't yank.
  useEffect(() => {
    if (!stickTop) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [steps, stickTop]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Live log
        </div>
        <div className="text-[10px] text-muted-foreground">{steps.length} recent</div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => setStickTop((e.currentTarget as HTMLDivElement).scrollTop <= 4)}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-tight"
      >
        {steps.length === 0 ? (
          <div className="p-3 text-muted-foreground">waiting for steps…</div>
        ) : (
          <ul className="divide-y divide-border/50">
            {steps.map((s) => (
              <li key={`${s.row_id}:${s.idx}`} className="flex gap-2 px-3 py-1">
                <span className="shrink-0 text-muted-foreground">{fmtTime(s.finished_at ?? s.started_at)}</span>
                <span className="shrink-0 truncate max-w-[9rem]" title={nameById.get(s.row_id) ?? s.row_id}>
                  {nameById.get(s.row_id) ?? s.row_id}
                </span>
                <span className="text-muted-foreground">›</span>
                <span className="shrink-0 truncate max-w-[7rem]">{s.chosen_tool ?? "stop"}</span>
                <span className={`shrink-0 ${statusColor(s.status)}`}>{s.status}</span>
                <span className="shrink-0 text-muted-foreground">{fmtCents(s.tool_cost_cents ?? 0)}</span>
                {s.status === "error" && s.error_message && (
                  <span className="truncate text-red-400" title={s.error_message}>
                    {s.error_message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
