"use client";

import { useState } from "react";
import {
  Building2Icon,
  CheckIcon,
  CopyIcon,
  FlagIcon,
  GlobeIcon,
  MessageCircleIcon,
  RotateCcwIcon,
  SearchIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Step, StepStatus } from "@/lib/firestore/schema";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/auth-provider";
import { cn } from "@/lib/utils";

function statusVariant(status: StepStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case "running":
      return { label: "running…", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" };
    case "done":
      return { label: "done", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" };
    case "error":
      return { label: "error", className: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" };
    case "skipped":
      return { label: "skipped", className: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30" };
  }
}

function confidenceBar(c: number): string {
  if (c >= 0.8) return "bg-emerald-500";
  if (c >= 0.5) return "bg-amber-500";
  return "bg-zinc-400";
}

function toolPresentation(tool: string | null): {
  Icon: LucideIcon;
  label: string;
} {
  switch (tool) {
    case "firecrawl_website":
      return { Icon: GlobeIcon, label: "Web scrape" };
    case "web_search":
      return { Icon: SearchIcon, label: "Web search" };
    case "linkedin_profile":
      return { Icon: UserIcon, label: "LinkedIn profile" };
    case "linkedin_company":
      return { Icon: Building2Icon, label: "LinkedIn company" };
    case "grok_x_lookup":
      return { Icon: MessageCircleIcon, label: "X search" };
    default:
      return { Icon: FlagIcon, label: "Stop" };
  }
}

type FieldDelta = {
  value?: unknown;
  confidence?: number;
  evidence_quote?: string | null;
};

function isFieldDelta(v: unknown): v is FieldDelta {
  return typeof v === "object" && v !== null && "confidence" in v;
}

type RecentPost = { date: string; text: string };

function isRecentPostArray(v: unknown): v is RecentPost[] {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>).date === "string" &&
        typeof (p as Record<string, unknown>).text === "string",
    )
  );
}

// Fields rendered in a dedicated block above the raw output; skipped in the
// generic extracted-fields loop so the list doesn't double up.
const X_SIGNAL_KEYS = new Set(["x_voice_summary", "x_recent_posts"]);

export function StepCard({
  step,
  onRerun,
}: {
  step: Step;
  onRerun?: () => Promise<void> | void;
}) {
  const s = statusVariant(step.status);
  const extracted = step.extracted_fields as Record<string, unknown>;
  const [copied, setCopied] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const { user } = useAuth();
  const { Icon: ToolIcon, label: toolLabel } = toolPresentation(step.chosen_tool);
  const stepNumber = step.idx + 1;

  async function copyStep() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(step, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable (non-HTTPS, permission denied) — silent fail
    }
  }

  async function redoStep() {
    if (!user) return;
    const confirmMsg =
      `Redo from step ${stepNumber}?\n\n` +
      `This deletes this step and any later steps, refunds their budget, then re-runs from here. ` +
      `Row fields already merged from those steps will NOT be cleared — only the audit log is rewound.`;
    if (!window.confirm(confirmMsg)) return;
    setRedoing(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(
        `/api/step/redo?rowId=${encodeURIComponent(step.row_id)}&fromIdx=${step.idx}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const body = (await res.json()) as {
        ok?: boolean;
        deleted?: number;
        refunded_cents?: number;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        toast.error(`Redo failed: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      if (onRerun) {
        toast.success(
          `Rewound to step ${stepNumber} — deleted ${body.deleted}, refunded ${body.refunded_cents}¢. Re-running…`,
        );
        await onRerun();
      } else {
        toast.success(
          `Rewound to step ${stepNumber} — deleted ${body.deleted}, refunded ${body.refunded_cents}¢.`,
        );
      }
    } catch (e) {
      toast.error(`Redo failed: ${(e as Error).message}`);
    } finally {
      setRedoing(false);
    }
  }

  return (
    <div className="min-w-0 rounded-md border bg-card p-3 text-sm ring-1 ring-foreground/5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tabular-nums text-foreground">
            Step {stepNumber}
          </span>
          <Badge
            variant="outline"
            className="gap-1 text-[11px]"
            title={step.chosen_tool ?? "stop"}
          >
            <ToolIcon className="size-3" />
            {toolLabel}
          </Badge>
          <span
            className={cn(
              "rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
              s.className,
            )}
          >
            {s.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {step.tool_cost_cents > 0 ? `${step.tool_cost_cents}¢` : ""}
          </span>
          <button
            type="button"
            onClick={redoStep}
            disabled={redoing}
            title="Rewind log to this step and re-run"
            aria-label="Rewind log to this step"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RotateCcwIcon
              className={cn("size-3.5", redoing && "animate-spin")}
            />
          </button>
          <button
            type="button"
            onClick={copyStep}
            title="Copy step as JSON"
            aria-label="Copy step as JSON"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </button>
        </div>
      </div>

      {step.decision_reasoning && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            reasoning
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground/80">
            {step.decision_reasoning}
          </p>
        </details>
      )}

      {Object.keys(step.chosen_tool_args ?? {}).length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            tool args
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-tight">
            {JSON.stringify(step.chosen_tool_args, null, 2)}
          </pre>
        </details>
      )}

      {Object.keys(extracted).length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            extracted
          </div>
          {Object.entries(extracted).map(([field, v]) => {
            if (X_SIGNAL_KEYS.has(field)) return null;
            if (!isFieldDelta(v)) return null;
            const conf = v.confidence ?? 0;
            const valueStr = (() => {
              if (Array.isArray(v.value)) {
                return v.value
                  .map((item) => {
                    if (typeof item === "string") return item;
                    if (item && typeof item === "object" && "name" in item) {
                      const o = item as { name?: unknown; title?: unknown };
                      if (typeof o.name === "string") {
                        return typeof o.title === "string" && o.title.length > 0
                          ? `${o.name} (${o.title})`
                          : o.name;
                      }
                    }
                    return JSON.stringify(item);
                  })
                  .join(", ");
              }
              if (typeof v.value === "object" && v.value !== null) return JSON.stringify(v.value);
              return String(v.value ?? "");
            })();
            return (
              <div key={field} className="flex items-start gap-2 text-xs">
                <span className="w-28 shrink-0 font-mono text-[11px] text-muted-foreground">
                  {field}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "truncate",
                        conf < 0.5 && "text-muted-foreground line-through",
                      )}
                      title={valueStr}
                    >
                      {valueStr || "—"}
                    </span>
                    <div className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full", confidenceBar(conf))}
                        style={{ width: `${Math.round(conf * 100)}%` }}
                      />
                    </div>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {conf.toFixed(2)}
                    </span>
                  </div>
                  {v.evidence_quote && (
                    <div className="mt-0.5 break-words text-[10px] italic text-muted-foreground">
                      “{v.evidence_quote}”
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <XSignalBlock extracted={extracted} />

      {step.error_message && step.status !== "done" && (
        <div className="mt-2 break-words rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
          {step.error_message}
        </div>
      )}
      {step.error_message && step.status === "done" && step.chosen_tool == null && (
        <div className="mt-2 break-words rounded border border-zinc-500/30 bg-zinc-500/10 p-2 text-xs text-zinc-700 dark:text-zinc-300">
          stop_reason: {step.error_message}
        </div>
      )}

      {step.tool_raw_output !== null && step.tool_raw_output !== undefined && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            raw output
          </summary>
          <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-tight">
            {typeof step.tool_raw_output === "string"
              ? step.tool_raw_output
              : JSON.stringify(step.tool_raw_output, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function XSignalBlock({ extracted }: { extracted: Record<string, unknown> }) {
  const voiceDelta = extracted.x_voice_summary;
  const postsDelta = extracted.x_recent_posts;
  const voice =
    isFieldDelta(voiceDelta) && typeof voiceDelta.value === "string" && voiceDelta.value.trim().length > 0
      ? voiceDelta.value
      : null;
  const posts =
    isFieldDelta(postsDelta) && isRecentPostArray(postsDelta.value) && postsDelta.value.length > 0
      ? postsDelta.value
      : null;

  if (!voice && !posts) return null;

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 p-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
        X signal
      </div>
      {voice && (
        <blockquote className="border-l-2 border-sky-500/40 pl-2 text-xs italic text-foreground/80">
          {voice}
        </blockquote>
      )}
      {posts && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            recent posts ({posts.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-1.5">
            {posts.map((p, i) => (
              <li
                key={`${p.date}-${i}`}
                className="flex gap-2 text-[11px] leading-snug"
              >
                <span className="w-20 shrink-0 font-mono tabular-nums text-muted-foreground">
                  {p.date}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-words">
                  {p.text}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
