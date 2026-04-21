"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  CheckIcon,
  CopyIcon,
  DollarSignIcon,
  GlobeIcon,
  LayersIcon,
  Loader2Icon,
  MailIcon,
  MapPinIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlayIcon,
  RotateCcwIcon,
  StepForwardIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Row, Step } from "@/lib/firestore/schema";
import { useRow } from "@/lib/firestore/useRow";
import { useSteps } from "@/lib/firestore/useSteps";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StepLog } from "@/components/step-log";
import { useAuth } from "@/components/auth-provider";
import {
  DISPLAY_STEP_BUDGET_CENTS_PER_ROW,
  DISPLAY_STEP_MAX_PER_ROW,
} from "@/lib/limits";
import { cn } from "@/lib/utils";

function formatCheck(min: number | null, max: number | null): string {
  if (min == null && max == null) return "—";
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
      ? `$${Math.round(n / 1_000)}k`
      : `$${n}`;
  if (min != null && max != null) return `${fmt(min)}–${fmt(max)}`;
  return fmt((min ?? max) as number);
}

// Strip protocol + path + "www." and lowercase. Returns null for null/empty/
// strings that don't parse cleanly so the favicon path is never called with
// junk input.
function getDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withProto).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

function InitialBadge({
  name,
  size,
  rounded = "md",
}: {
  name: string | null | undefined;
  size: number;
  rounded?: "md" | "full";
}) {
  const fontSize = Math.max(10, Math.round(size * 0.38));
  return (
    <div
      style={{ width: size, height: size, fontSize }}
      className={cn(
        "flex shrink-0 select-none items-center justify-center border bg-muted font-semibold uppercase tracking-tight text-muted-foreground",
        rounded === "full" ? "rounded-full" : "rounded-md",
      )}
      aria-hidden
    >
      {getInitials(name)}
    </div>
  );
}

// Firm/portfolio logo with a three-step fallback: a direct image URL (from
// LinkedIn/OG scrape) → Google's public favicon service keyed on a domain →
// an initial-badge. Each step advances on image-load error. The effect on
// [imageUrl, domain] resets the broken flag when the props change so
// reopening the drawer for a different row starts fresh.
function Logo({
  imageUrl,
  domain,
  name,
  size = 40,
  rounded = "md",
}: {
  imageUrl?: string | null;
  domain: string | null;
  name: string | null | undefined;
  size?: number;
  rounded?: "md" | "full";
}) {
  const [step, setStep] = useState<0 | 1 | 2>(() =>
    imageUrl ? 0 : domain ? 1 : 2,
  );
  useEffect(() => {
    setStep(imageUrl ? 0 : domain ? 1 : 2);
  }, [imageUrl, domain]);

  if (step === 2) {
    return <InitialBadge name={name} size={size} rounded={rounded} />;
  }

  const src =
    step === 0
      ? (imageUrl as string)
      : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
          domain as string,
        )}&sz=128`;

  return (
    <img
      src={src}
      onError={() => setStep((s) => (s === 0 && domain ? 1 : 2))}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      alt=""
      referrerPolicy="no-referrer"
      className={cn(
        "shrink-0 border bg-white object-cover",
        step === 1 && "object-contain p-0.5",
        rounded === "full" ? "rounded-full" : "rounded-md",
      )}
    />
  );
}

// icons8 CDN — plain <img> tags, no auth, no bundle cost. `ios-glyphs` is a
// clean monochrome style that inherits neither a color nor a background so it
// sits comfortably next to our text links.
function BrandIcon({
  kind,
  className,
  size = 14,
}: {
  kind: "linkedin" | "x";
  className?: string;
  size?: number;
}) {
  const slug = kind === "x" ? "twitterx" : "linkedin";
  const src = `https://img.icons8.com/ios-glyphs/30/${slug}.png`;
  return (
    <img
      src={src}
      alt={kind === "linkedin" ? "LinkedIn" : "X / Twitter"}
      width={size}
      height={size}
      className={cn("inline-block shrink-0 opacity-80", className)}
    />
  );
}

function QuickLink({
  href,
  label,
  children,
}: {
  href: string | null | undefined;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      title={label}
      className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-muted hover:text-foreground"
    >
      {children}
    </a>
  );
}

function KpiBlock({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium text-foreground">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function MandateRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  );
}

type StepResponse =
  | {
      stepId: string;
      status: "done" | "skipped";
      merged?: string[];
      stop_reason?: string | null;
      skipped_reason?: string | null;
    }
  | { stepId: string; status: "error"; error?: string }
  | { error: string };

type OrchestratorActions = {
  runStep: () => Promise<void>;
  runAll: () => Promise<void>;
  runReset: () => Promise<void>;
  resetting: boolean;
  inFlight: boolean;
  capped: boolean;
};

function useOrchestrator(row: Row): OrchestratorActions {
  const { user } = useAuth();
  const [resetting, setResetting] = useState(false);
  const [inFlight, setInFlight] = useState(false);

  const stepsUsed = row.total_steps ?? 0;
  const centsUsed = row.tool_budget_cents_used ?? 0;
  const capped =
    stepsUsed >= DISPLAY_STEP_MAX_PER_ROW ||
    centsUsed >= DISPLAY_STEP_BUDGET_CENTS_PER_ROW;

  // Loop safety — server caps at DISPLAY_STEP_MAX_PER_ROW but we bound client iterations too.
  const RUN_ALL_MAX_ITERATIONS = 12;

  async function runStep() {
    if (!user) return;
    setInFlight(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/step", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rowId: row.id }),
      });
      const body = (await res.json()) as StepResponse;
      if (!res.ok) {
        const msg = "error" in body ? body.error : `HTTP ${res.status}`;
        toast.error(`Step failed: ${msg}`);
        return;
      }
      if ("status" in body) {
        if (body.status === "error") {
          toast.error(`Step error: ${body.error ?? "unknown"}`);
        } else if (body.status === "skipped") {
          toast.warning(`Step skipped: ${body.skipped_reason ?? "budget"}`);
        } else if ("stop_reason" in body && body.stop_reason) {
          toast.message(`Orchestrator stopped: ${body.stop_reason}`);
        } else {
          const merged = "merged" in body ? body.merged ?? [] : [];
          toast.success(
            merged.length > 0
              ? `Step done. Merged: ${merged.join(", ")}`
              : "Step done. No fields met the confidence floor.",
          );
        }
      }
    } catch (e) {
      toast.error(`Step failed: ${(e as Error).message}`);
    } finally {
      setInFlight(false);
    }
  }

  async function runAll() {
    if (!user || inFlight) return;
    const label = row.name ?? row.id;
    setInFlight(true);
    try {
      for (let i = 0; i < RUN_ALL_MAX_ITERATIONS; i++) {
        let body: StepResponse;
        try {
          const token = await user.getIdToken();
          const res = await fetch("/api/step", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ rowId: row.id }),
          });
          body = (await res.json()) as StepResponse;
          if (!res.ok && !("status" in body)) {
            const msg = "error" in body ? body.error : `HTTP ${res.status}`;
            toast.error(`${label}: ${msg}`);
            return;
          }
        } catch (e) {
          toast.error(`${label}: ${(e as Error).message}`);
          return;
        }
        if ("status" in body) {
          if (body.status === "error") {
            toast.error(`${label}: ${body.error ?? "error"}`);
            return;
          }
          if (body.status === "skipped") {
            toast.warning(`${label}: ${body.skipped_reason ?? "budget"}`);
            return;
          }
          if ("stop_reason" in body && body.stop_reason) {
            toast.success(`${label}: done · ${body.stop_reason}`);
            return;
          }
        }
      }
      toast.message(`${label}: reached step cap`);
    } finally {
      setInFlight(false);
    }
  }

  async function runReset() {
    if (!user) return;
    if (!window.confirm(`Reset row ${row.id}? Wipes all steps and zeroes counters.`)) return;
    setResetting(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/step/reset?rowId=${encodeURIComponent(row.id)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        toast.error(`Reset failed: ${body.error ?? "unknown"}`);
        return;
      }
      toast.success("Row reset.");
    } catch (e) {
      toast.error(`Reset failed: ${(e as Error).message}`);
    } finally {
      setResetting(false);
    }
  }

  return {
    runStep,
    runAll,
    runReset,
    resetting,
    inFlight,
    capped,
  };
}

function OrchestratorHeaderActions({
  orch,
  devMode,
}: {
  orch: OrchestratorActions;
  devMode: boolean;
}) {
  const { runStep, runAll, runReset, resetting, inFlight, capped } = orch;
  const busy = inFlight || capped;
  return (
    <div className="flex items-center gap-0.5">
      {devMode && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={runReset}
          disabled={resetting || inFlight}
          title={resetting ? "Resetting…" : "Reset row (dev): wipes steps + counters"}
          aria-label="Reset"
        >
          <RotateCcwIcon className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={runStep}
        disabled={busy}
        title={capped ? "Budget reached. Reset to re-run." : "Run next step"}
        aria-label="Step"
      >
        <StepForwardIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={runAll}
        disabled={busy}
        title={
          capped
            ? "Budget reached. Reset to re-run."
            : "Run all: loop steps until done or budget is reached"
        }
        aria-label="Run all"
      >
        <PlayIcon className="size-4" />
      </Button>
    </div>
  );
}

function OrchestratorBlock({
  row,
  steps,
  stepsLoading,
  stepsError,
  orch,
}: {
  row: Row;
  steps: Step[];
  stepsLoading: boolean;
  stepsError: string | null;
  orch: OrchestratorActions;
}) {
  const stepsUsed = row.total_steps ?? 0;
  const centsUsed = row.tool_budget_cents_used ?? 0;
  const { capped, runStep } = orch;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Orchestrator
        </h3>
        <div className="flex items-center gap-2 text-xs tabular-nums">
          <Badge variant={capped ? "destructive" : "outline"}>
            {stepsUsed}/{DISPLAY_STEP_MAX_PER_ROW} steps
          </Badge>
          <Badge variant={capped ? "destructive" : "outline"}>
            {centsUsed}¢/{DISPLAY_STEP_BUDGET_CENTS_PER_ROW}¢
          </Badge>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {row.last_enriched_at
          ? `Last enriched ${new Date(row.last_enriched_at).toLocaleString()}`
          : "Never enriched."}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border bg-background">
        <StepLog
          rowId={row.id}
          steps={steps}
          loading={stepsLoading}
          error={stepsError}
          onRerun={runStep}
        />
      </div>
    </section>
  );
}

type ScrapeStatusPill = {
  label: string;
  className: string;
  description: string;
};

// Turn the short reason tag from computeScrapeStatus into a plain-English
// fragment that slots into a sentence. Keep fragments lowercase and verb-led
// so callers can paste them after "Every scrape attempt failed —".
function humanizeScrapeReason(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case "5xx error":
      return "the site returned 500-level server errors";
    case "4xx blocked":
      return "the site blocked our requests (403/404/etc.)";
    case "DNS error":
      return "the domain didn't resolve";
    case "cert error":
      return "the site has a broken SSL certificate";
    case "timeout":
      return "requests timed out";
    case "connection refused":
      return "the server refused the connection";
    case "empty response":
      return "the server closed the connection without sending anything";
    case "proxy error":
      return "the network proxy tunnel failed";
    case "scrape failed":
      return "the scraper couldn't load the page";
    case "extract failed":
      return "the extractor couldn't parse the page";
    case "budget":
      return "the per-row budget was hit";
    case "errors + empty":
      return "some requests errored and the rest came back empty";
    case "empty pages":
      return "pages loaded but had no extractable content";
    default:
      return reason;
  }
}

function deriveScrapeStatusPill(
  row: Row,
  steps: Step[],
  inFlight: boolean,
): ScrapeStatusPill {
  const hasRunningStep = steps.some((s) => s.status === "running");
  if (inFlight || hasRunningStep) {
    return {
      label: "Scraping…",
      className:
        "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30 animate-pulse",
      description: "A step is running right now.",
    };
  }
  const status = row.scrape_status ?? null;
  const reason = humanizeScrapeReason(row.scrape_status_reason ?? null);
  if (status === null) {
    if ((row.total_steps ?? 0) === 0) {
      return {
        label: "Not started",
        className: "bg-muted text-muted-foreground border-border",
        description: "No scrape steps have run yet.",
      };
    }
    return {
      label: "Unknown",
      className: "bg-muted text-muted-foreground border-border",
      description: "Status couldn't be classified from the step history.",
    };
  }
  if (status === "complete") {
    return {
      label: "Complete",
      className:
        "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      description: "All required fields are filled.",
    };
  }
  if (status === "partial") {
    return {
      label: "Partial",
      className: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
      description: "Some fields filled, but required ones are still missing.",
    };
  }
  if (status === "dead_site") {
    return {
      label: "Dead site",
      className: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
      description: reason
        ? `Multiple scrapes returned nothing usable — ${reason}.`
        : "Multiple scrapes returned nothing usable.",
    };
  }
  // error_only
  return {
    label: "Errors",
    className:
      "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    description: reason
      ? `Every scrape attempt failed — ${reason}.`
      : "Every scrape attempt so far has errored.",
  };
}

function InvestmentProfileCard({ row }: { row: Row }) {
  const sectors = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const s of [...row.sectors_l1, ...row.sectors_l2]) {
      const key = s.trim();
      if (!key || seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      ordered.push(key);
    }
    return ordered;
  }, [row.sectors_l1, row.sectors_l2]);

  const check = formatCheck(row.check_min_usd, row.check_max_usd);
  const stages = row.stages.length ? row.stages.join(" · ") : null;

  const mandate: Array<{ label: string; value: React.ReactNode }> = [];
  const hqParts = [row.hq_address, row.hq_country].filter(Boolean) as string[];
  if (hqParts.length) {
    mandate.push({ label: "HQ", value: hqParts.join(" · ") });
  }
  if (row.countries_invest.length) {
    mandate.push({
      label: "Invests in",
      value: row.countries_invest.join(", "),
    });
  }
  if (row.num_investments_band) {
    mandate.push({
      label: "# investments",
      value: row.num_investments_band,
    });
  }
  if (row.check_bands.length) {
    mandate.push({
      label: "Check bands",
      value: row.check_bands.join(", "),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Investment profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <KpiBlock
            icon={<DollarSignIcon className="size-3.5" />}
            label="Check size"
            value={check}
            hint={row.check_raw ? row.check_raw : undefined}
          />
          <KpiBlock
            icon={<LayersIcon className="size-3.5" />}
            label="Stages"
            value={stages ?? <span className="text-muted-foreground">—</span>}
          />
        </div>
        <Separator />
        <KpiBlock
          icon={<TagIcon className="size-3.5" />}
          label="Sectors"
          value={
            sectors.length ? (
              <div className="flex flex-wrap gap-1">
                {sectors.map((s) => (
                  <Badge key={s} variant="secondary" className="font-normal">
                    {s}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          }
        />
        {mandate.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              {mandate.map((r) => (
                <MandateRow key={r.label} label={r.label}>
                  {r.value}
                </MandateRow>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PortfolioBlock({
  companies,
}: {
  companies: NonNullable<Row["portfolio_companies"]>;
}) {
  // Group by fund; null/undefined fund entries fall into "Ungrouped".
  const groups = new Map<string, typeof companies>();
  for (const c of companies) {
    const key = c.fund ?? "";
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portfolio ({companies.length})</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {orderedKeys.map((k) => {
          const arr = groups.get(k)!;
          return (
            <div key={k || "ungrouped"} className="flex flex-col gap-1.5">
              {k && (
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {k} ({arr.length})
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {arr.map((c, i) => {
                  const domain = getDomain(c.url ?? null);
                  const chip = (
                    <span className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs font-medium text-foreground">
                      <Logo
                        imageUrl={c.logo_url ?? null}
                        domain={domain}
                        name={c.name}
                        size={16}
                      />
                      <span className="truncate max-w-[12rem]">{c.name}</span>
                    </span>
                  );
                  return (
                    <span key={`${c.name}-${i}`}>
                      {c.url ? (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={c.url}
                          className="inline-flex transition-colors hover:[&>span]:border-foreground/30 hover:[&>span]:bg-muted"
                        >
                          {chip}
                        </a>
                      ) : (
                        chip
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

type PartnerRow = NonNullable<Row["partners"]>[number];

function PartnerXBlock({ partner }: { partner: PartnerRow }) {
  const hasVoice =
    typeof partner.x_voice_summary === "string" && partner.x_voice_summary.trim().length > 0;
  const posts = partner.x_recent_posts ?? [];
  if (!hasVoice && posts.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 p-3">
      {partner.x_handle && (
        <a
          href={`https://twitter.com/${partner.x_handle}`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1.5 text-xs font-mono text-sky-700 hover:underline dark:text-sky-300"
        >
          <BrandIcon kind="x" size={12} />
          @{partner.x_handle}
        </a>
      )}
      {hasVoice && (
        <blockquote className="border-l-2 border-sky-500/50 pl-2 text-xs italic leading-relaxed text-foreground/85">
          {partner.x_voice_summary}
        </blockquote>
      )}
      {posts.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {posts.slice(0, 5).map((p, i) => (
            <li key={`${p.date}-${i}`} className="flex gap-2">
              <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {p.date}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-words leading-relaxed">
                {p.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PartnersCard({ row }: { row: Row }) {
  const { user } = useAuth();
  const [loadingName, setLoadingName] = useState<string | null>(null);
  const partners = row.partners ?? [];

  async function lookup(partnerName: string) {
    if (!user || loadingName) return;
    setLoadingName(partnerName);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/partner/x-lookup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rowId: row.id, partnerName }),
      });
      const body = (await res.json()) as
        | { ok: true; handle: string | null; voice_summary: string | null; cost_cents: number }
        | { error: string };
      if (!res.ok || !("ok" in body)) {
        const msg = "error" in body ? body.error : `HTTP ${res.status}`;
        toast.error(`${partnerName}: ${msg}`);
        return;
      }
      toast.success(
        `${partnerName}: ${body.handle ? `@${body.handle} · ` : ""}${body.cost_cents}¢`,
      );
    } catch (e) {
      toast.error(`${partnerName}: ${(e as Error).message}`);
    } finally {
      setLoadingName(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>People ({partners.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {partners.map((p, i) => {
            const busy = loadingName === p.name;
            const hasX =
              (typeof p.x_voice_summary === "string" && p.x_voice_summary.trim().length > 0) ||
              (p.x_recent_posts ?? []).length > 0;
            return (
              <li
                key={`${p.name}-${i}`}
                className={cn(
                  "flex flex-col py-2",
                  i > 0 && "border-t border-border/60",
                )}
              >
                <div className="flex items-center gap-3">
                  <Logo
                    imageUrl={p.photo_url ?? null}
                    domain={null}
                    name={p.name}
                    size={32}
                    rounded="full"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    {p.title && (
                      <span className="truncate text-xs text-muted-foreground">
                        {p.title}
                      </span>
                    )}
                  </div>
                  {p.linkedin_url && (
                    <a
                      href={p.linkedin_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      aria-label={`${p.name} on LinkedIn`}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground"
                    >
                      <BrandIcon kind="linkedin" size={14} />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => lookup(p.name)}
                    disabled={busy || loadingName !== null}
                    aria-label={
                      hasX ? `Refresh X lookup for ${p.name}` : `Look up ${p.name} on X`
                    }
                    title={
                      busy
                        ? "Looking up on X…"
                        : hasX
                        ? `Refresh X lookup for ${p.name} (~1¢)`
                        : `Look up ${p.name} on X (~1¢)`
                    }
                    className={cn(
                      "inline-flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
                      hasX
                        ? "border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                        : "border-border text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {busy ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <BrandIcon kind="x" size={14} />
                    )}
                  </button>
                </div>
                <PartnerXBlock partner={p} />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function CopyIdButton({ row, steps }: { row: Row; steps: Step[] }) {
  const [copied, setCopied] = useState(false);

  async function onClick() {
    const payload = { id: row.id, row, steps };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      toast.success(
        `Copied row ${row.id} (${steps.length} step${steps.length === 1 ? "" : "s"})`,
      );
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Copy id ${row.id} + row + steps as JSON`}
      aria-label="Copy row and steps as JSON"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

function twitterHref(twitter: string | null): string | null {
  if (!twitter) return null;
  return twitter.startsWith("http")
    ? twitter
    : `https://twitter.com/${twitter.replace(/^@/, "")}`;
}

export function RowDetailDrawer({
  row: rowProp,
  open,
  onOpenChange,
  devMode = false,
}: {
  row: Row | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devMode?: boolean;
}) {
  // Subscribe live to the selected row so merged fields (partners, portfolio,
  // thesis, ...) refresh as soon as a step finishes. Fall back to the prop
  // snapshot for the initial open frame or if the subscription hasn't landed.
  const { row: liveRow } = useRow(rowProp?.id ?? null);
  const row = liveRow ?? rowProp;

  // One shared step subscription — reused by StepLog and by the header pill.
  const { steps, loading: stepsLoading, error: stepsError } = useSteps(
    row?.id ?? null,
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-50 bg-black/20 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-full w-[60vw] max-w-none flex-col gap-0 border-l bg-background shadow-xl outline-none duration-200",
            "data-open:animate-in data-open:slide-in-from-right-full data-closed:animate-out data-closed:slide-out-to-right-full",
          )}
        >
          {row && (
            <RowDrawerContent
              row={row}
              steps={steps}
              stepsLoading={stepsLoading}
              stepsError={stepsError}
              devMode={devMode}
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function RowDrawerContent({
  row,
  steps,
  stepsLoading,
  stepsError,
  devMode,
}: {
  row: Row;
  steps: Step[];
  stepsLoading: boolean;
  stepsError: string | null;
  devMode: boolean;
}) {
  const orch = useOrchestrator(row);
  const [orchestratorOpen, setOrchestratorOpen] = useState(true);

  const statusPill = useMemo(
    () => deriveScrapeStatusPill(row, steps, orch.inFlight),
    [row, steps, orch.inFlight],
  );

  const firmDomain = useMemo(() => getDomain(row.website), [row]);

  const personName =
    [row.person_first, row.person_last].filter(Boolean).join(" ") || null;

  return (
    <>
              <header className="flex flex-col gap-3 border-b bg-muted/30 px-6 py-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-4">
                    <Logo
                      imageUrl={row.logo_url ?? null}
                      domain={firmDomain}
                      name={row.name ?? row.firm_name}
                      size={52}
                    />
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <CopyIdButton row={row} steps={steps} />
                        <DialogPrimitive.Title className="truncate font-heading text-xl font-semibold leading-tight">
                          {row.name ?? "(unnamed)"}
                        </DialogPrimitive.Title>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="font-medium">
                          {row.investor_type.replace(/_/g, " ")}
                        </Badge>
                        {row.firm_name && row.firm_name !== row.name && (
                          <span className="text-foreground/80">
                            {row.firm_name}
                          </span>
                        )}
                        {firmDomain && (
                          <span className="font-mono text-[11px] text-muted-foreground/80">
                            {firmDomain}
                          </span>
                        )}
                      </div>
                      {statusPill && (
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                              statusPill.className,
                            )}
                          >
                            {statusPill.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {statusPill.description}
                          </span>
                        </div>
                      )}
                      {(row.website ||
                        row.linkedin ||
                        row.twitter ||
                        row.email) && (
                        <div className="flex items-center gap-1.5 pt-1">
                          <QuickLink href={row.website} label="Website">
                            <GlobeIcon className="size-4" />
                          </QuickLink>
                          <QuickLink href={row.linkedin} label="LinkedIn">
                            <BrandIcon kind="linkedin" size={16} />
                          </QuickLink>
                          <QuickLink
                            href={twitterHref(row.twitter)}
                            label="X / Twitter"
                          >
                            <BrandIcon kind="x" size={16} />
                          </QuickLink>
                          <QuickLink
                            href={row.email ? `mailto:${row.email}` : null}
                            label={row.email ?? "Email"}
                          >
                            <MailIcon className="size-4" />
                          </QuickLink>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <OrchestratorHeaderActions orch={orch} devMode={devMode} />
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Completeness
                      </span>
                      <Badge
                        variant={
                          row.completeness_score >= 70
                            ? "default"
                            : row.completeness_score >= 40
                            ? "secondary"
                            : "outline"
                        }
                        className="tabular-nums"
                      >
                        {row.completeness_score}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setOrchestratorOpen((v) => !v)}
                      title={
                        orchestratorOpen
                          ? "Collapse orchestrator"
                          : "Expand orchestrator"
                      }
                      aria-label={
                        orchestratorOpen
                          ? "Collapse orchestrator"
                          : "Expand orchestrator"
                      }
                      aria-expanded={orchestratorOpen}
                    >
                      {orchestratorOpen ? (
                        <PanelRightCloseIcon className="size-4" />
                      ) : (
                        <PanelRightOpenIcon className="size-4" />
                      )}
                    </Button>
                    <DialogPrimitive.Close
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Close"
                        />
                      }
                    >
                      <XIcon className="size-4" />
                    </DialogPrimitive.Close>
                  </div>
                </div>
              </header>

              <div
                className={cn(
                  "grid min-h-0 flex-1 gap-0",
                  orchestratorOpen ? "grid-cols-2" : "grid-cols-1",
                )}
              >
                <div className="min-h-0 overflow-y-auto px-6 py-5">
                  <div className="flex flex-col gap-4">
                    <InvestmentProfileCard row={row} />

                    {row.thesis && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Thesis</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                            {row.thesis}
                          </p>
                        </CardContent>
                      </Card>
                    )}

                    {personName && (
                      <Card size="sm">
                        <CardHeader>
                          <CardTitle>Contact person</CardTitle>
                        </CardHeader>
                        <CardContent className="flex items-center gap-3">
                          <InitialBadge
                            name={personName}
                            size={36}
                            rounded="full"
                          />
                          <span className="text-sm font-medium">
                            {personName}
                          </span>
                        </CardContent>
                      </Card>
                    )}

                    {row.partners && row.partners.length > 0 && (
                      <PartnersCard row={row} />
                    )}

                    {row.portfolio_companies &&
                      row.portfolio_companies.length > 0 && (
                        <PortfolioBlock companies={row.portfolio_companies} />
                      )}

                    {row.x_voice_summary && (
                      <Card>
                        <CardHeader>
                          <CardTitle>X voice</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <blockquote className="border-l-2 border-sky-500/50 pl-3 text-sm italic leading-relaxed text-foreground/85">
                            {row.x_voice_summary}
                          </blockquote>
                        </CardContent>
                      </Card>
                    )}

                    {row.x_recent_posts &&
                      row.x_recent_posts.length > 0 && (
                        <Card>
                          <CardHeader>
                            <CardTitle>
                              Recent posts ({row.x_recent_posts.length})
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <ul className="flex flex-col">
                              {row.x_recent_posts.map((p, i) => (
                                <li
                                  key={`${p.date}-${i}`}
                                  className={cn(
                                    "flex gap-3 py-2 text-sm",
                                    i > 0 && "border-t border-border/60",
                                  )}
                                >
                                  <span className="w-20 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                    {p.date}
                                  </span>
                                  <span className="flex-1 whitespace-pre-wrap break-words leading-relaxed">
                                    {p.text}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </CardContent>
                        </Card>
                      )}

                    {row.notes && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Notes</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                            {row.notes}
                          </p>
                        </CardContent>
                      </Card>
                    )}

                    <Separator className="mt-2" />
                    <footer className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {row.missing_fields.length > 0 && (
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-muted-foreground/80">
                            Missing:
                          </span>
                          <span className="flex-1 break-words">
                            {row.missing_fields.join(", ")}
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>
                          <span className="text-muted-foreground/70">
                            Source
                          </span>{" "}
                          {row.source}
                        </span>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="font-mono">
                          <span className="text-muted-foreground/70">ID</span>{" "}
                          {row.id}
                        </span>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="tabular-nums">
                          <span className="text-muted-foreground/70">
                            Steps
                          </span>{" "}
                          {row.total_steps}
                        </span>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="tabular-nums">
                          <span className="text-muted-foreground/70">
                            Budget
                          </span>{" "}
                          {row.tool_budget_cents_used}¢
                        </span>
                        {row.last_enriched_at && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span>
                              <span className="text-muted-foreground/70">
                                Enriched
                              </span>{" "}
                              {new Date(
                                row.last_enriched_at,
                              ).toLocaleDateString()}
                            </span>
                          </>
                        )}
                        {row.hq_country && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span className="inline-flex items-center gap-1">
                              <MapPinIcon className="size-3" />
                              {row.hq_country}
                            </span>
                          </>
                        )}
                      </div>
                    </footer>
                  </div>
                </div>

                {orchestratorOpen && (
                  <div className="flex min-h-0 min-w-0 flex-col border-l bg-muted/20 px-5 py-5">
                    <OrchestratorBlock
                      row={row}
                      steps={steps}
                      stepsLoading={stepsLoading}
                      stepsError={stepsError}
                      orch={orch}
                    />
                  </div>
                )}
              </div>
    </>
  );
}
