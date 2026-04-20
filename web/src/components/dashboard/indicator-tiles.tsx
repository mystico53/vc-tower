"use client";

import { useMemo } from "react";
import type { Row } from "@/lib/firestore/schema";

const ASSUMED_STEPS_PER_ROW = 8;

function formatMoney(cents: number): string {
  if (cents < 100) return `$${(cents / 100).toFixed(2)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, "0")}m`;
}

export function IndicatorTiles({
  rows,
  runningRowIds,
  completionsLast60s,
}: {
  rows: Row[];
  runningRowIds: Set<string>;
  completionsLast60s: number;
}) {
  const stats = useMemo(() => {
    let scoreSum = 0;
    let spendCents = 0;
    let done = 0;
    let untouched = 0;
    let stepsDone = 0;
    for (const r of rows) {
      scoreSum += r.completeness_score ?? 0;
      spendCents += r.tool_budget_cents_used ?? 0;
      stepsDone += r.total_steps ?? 0;
      if (r.scrape_status === "complete") done += 1;
      if ((r.total_steps ?? 0) === 0 && !r.last_enriched_at) untouched += 1;
    }
    const running = runningRowIds.size;
    const total = rows.length;
    const queued = Math.max(0, untouched - running);
    const pctAvgScore = total > 0 ? scoreSum / total : 0;
    const stepsPerMin = completionsLast60s;

    const totalTargetSteps = total * ASSUMED_STEPS_PER_ROW;
    const stepsRemaining = Math.max(0, totalTargetSteps - stepsDone);
    const etaSeconds = stepsPerMin > 0 ? (stepsRemaining / stepsPerMin) * 60 : Infinity;

    return {
      pctAvgScore,
      spendCents,
      spendPerRowCents: total > 0 ? spendCents / total : 0,
      done,
      running,
      queued,
      total,
      stepsPerMin,
      etaSeconds,
      stepsDone,
    };
  }, [rows, runningRowIds, completionsLast60s]);

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-2">
      <Tile label="Progress">
        <ProgressRing pct={stats.pctAvgScore} />
        <div className="mt-1 text-[11px] text-muted-foreground">avg completeness</div>
      </Tile>
      <Tile label="Spend">
        <div className="font-heading text-2xl">{formatMoney(stats.spendCents)}</div>
        <div className="text-[11px] text-muted-foreground">
          {formatMoney(stats.spendPerRowCents)} / row · {stats.stepsDone.toLocaleString()} steps
        </div>
      </Tile>
      <Tile label="Rows">
        <div className="flex items-baseline gap-2 text-sm">
          <Counter color="green" value={stats.done} label="done" />
          <Counter color="orange" value={stats.running} label="run" />
          <Counter color="muted" value={stats.queued} label="queued" />
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          of {stats.total.toLocaleString()}
        </div>
      </Tile>
      <Tile label="Throughput">
        <div className="font-heading text-2xl">{stats.stepsPerMin}/min</div>
        <div className="text-[11px] text-muted-foreground">
          ETA {formatEta(stats.etaSeconds)}
        </div>
      </Tile>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[96px] flex-col rounded-md border bg-card p-3">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}

function Counter({ value, label, color }: { value: number; label: string; color: "green" | "orange" | "muted" }) {
  const cls =
    color === "green" ? "text-emerald-600 dark:text-emerald-400" :
    color === "orange" ? "text-orange-600 dark:text-orange-400" :
    "text-muted-foreground";
  return (
    <span className="flex items-baseline gap-0.5">
      <span className={`font-heading text-lg ${cls}`}>{value.toLocaleString()}</span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </span>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const size = 56;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--border)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="hsl(140 70% 30%)"
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="font-heading text-2xl">{Math.round(clamped)}%</span>
    </div>
  );
}
