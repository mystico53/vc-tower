"use client";

import { useEffect } from "react";
import { useSteps } from "@/lib/firestore/useSteps";
import type { Step } from "@/lib/firestore/schema";
import { StepCard } from "./step-card";

type StepLogProps = {
  rowId: string;
  steps?: Step[];
  loading?: boolean;
  error?: string | null;
  onRerun?: () => Promise<void> | void;
};

export function StepLog({ rowId, steps: stepsProp, loading: loadingProp, error: errorProp, onRerun }: StepLogProps) {
  const owned = useSteps(stepsProp === undefined ? rowId : null);
  const steps = stepsProp ?? owned.steps;
  const loading = loadingProp ?? owned.loading;
  const error = errorProp ?? owned.error;

  useEffect(() => {
    console.log("[StepLog] mount rowId=", rowId);
    return () => console.log("[StepLog] unmount rowId=", rowId);
  }, [rowId]);

  useEffect(() => {
    console.log("[StepLog] state", { rowId, loading, error, stepCount: steps.length });
  }, [rowId, loading, error, steps.length]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Step log
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {loading ? "loading…" : error ? "error" : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {loading ? (
        <div className="p-3 text-xs text-muted-foreground">Loading step log…</div>
      ) : error ? (
        <div className="p-3 text-xs text-red-600 dark:text-red-400">
          Step log error: {error}
        </div>
      ) : steps.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground">
          No steps yet. Click <b>Step</b> to run one.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="flex flex-col gap-2 p-3">
            {steps.map((s) => (
              <StepCard key={s.id} step={s} onRerun={onRerun} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
