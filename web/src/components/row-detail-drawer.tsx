"use client";

import { useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import type { Row } from "@/lib/firestore/schema";
import { useRow } from "@/lib/firestore/useRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MissingFieldsRow } from "@/components/field-status-pill";
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

function Field({
  label,
  children,
  span = 1,
}: {
  label: string;
  children: React.ReactNode;
  span?: 1 | 2;
}) {
  return (
    <div className={cn("flex flex-col gap-1", span === 2 && "col-span-2")}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="text-sm break-words">{children}</div>
    </div>
  );
}

function ExternalLink({ href, label }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary underline underline-offset-2 hover:text-foreground"
    >
      {label ?? href}
    </a>
  );
}

type StepResponse =
  | { stepId: string; status: "done" | "skipped"; merged?: string[]; stop_reason?: string | null; skipped_reason?: string | null }
  | { stepId: string; status: "error"; error?: string }
  | { error: string };

function OrchestratorBlock({
  row,
  devMode,
}: {
  row: Row;
  devMode: boolean;
}) {
  const { user } = useAuth();
  const [inFlight, setInFlight] = useState(false);
  const [resetting, setResetting] = useState(false);

  const stepsUsed = row.total_steps ?? 0;
  const centsUsed = row.tool_budget_cents_used ?? 0;
  const capped =
    stepsUsed >= DISPLAY_STEP_MAX_PER_ROW ||
    centsUsed >= DISPLAY_STEP_BUDGET_CENTS_PER_ROW;

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

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
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
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {row.last_enriched_at
            ? `Last enriched ${new Date(row.last_enriched_at).toLocaleString()}`
            : "Never enriched."}
        </span>
        <div className="flex items-center gap-2">
          {devMode && (
            <Button
              variant="outline"
              size="sm"
              onClick={runReset}
              disabled={resetting || inFlight}
              title="Dev-only: wipes steps + resets counters"
            >
              {resetting ? "Resetting…" : "Reset"}
            </Button>
          )}
          <Button
            onClick={runStep}
            disabled={inFlight || capped}
            size="sm"
            title={capped ? "Budget reached. Reset to re-run." : undefined}
          >
            {inFlight ? "Stepping…" : "Step"}
          </Button>
        </div>
      </div>
      <div className="flex h-64 flex-col overflow-hidden rounded border bg-background">
        <StepLog rowId={row.id} />
      </div>
    </section>
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
    <section className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Portfolio ({companies.length})
      </h3>
      <div className="flex flex-col gap-3">
        {orderedKeys.map((k) => {
          const arr = groups.get(k)!;
          return (
            <div key={k || "ungrouped"} className="flex flex-col gap-1">
              {k && (
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {k} ({arr.length})
                </div>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {arr.map((c, i) => (
                  <span key={`${c.name}-${i}`}>
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-primary underline underline-offset-2 hover:text-foreground"
                      >
                        {c.name}
                      </a>
                    ) : (
                      <span>{c.name}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ContactBlock({ row }: { row: Row }) {
  const { email, linkedin, website, twitter } = row;
  const hasAny = email || linkedin || website || twitter;
  return (
    <section className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Contact
      </h3>
      {!hasAny && (
        <p className="text-sm text-muted-foreground">No contact info yet.</p>
      )}
      {email && (
        <Field label="Email">
          <ExternalLink href={`mailto:${email}`} label={email} />
        </Field>
      )}
      {linkedin && (
        <Field label="LinkedIn">
          <ExternalLink href={linkedin} />
        </Field>
      )}
      {website && (
        <Field label="Website">
          <ExternalLink href={website} />
        </Field>
      )}
      {twitter && (
        <Field label="Twitter">
          <ExternalLink
            href={
              twitter.startsWith("http")
                ? twitter
                : `https://twitter.com/${twitter.replace(/^@/, "")}`
            }
            label={twitter}
          />
        </Field>
      )}
    </section>
  );
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

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-50 bg-black/20 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-xl flex-col gap-0 border-l bg-background shadow-xl outline-none duration-200",
            "data-open:animate-in data-open:slide-in-from-right-full data-closed:animate-out data-closed:slide-out-to-right-full",
          )}
        >
          {row && (
            <>
              <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
                <div className="flex flex-col gap-1">
                  <DialogPrimitive.Title className="font-heading text-lg leading-tight">
                    {row.name ?? "(unnamed)"}
                  </DialogPrimitive.Title>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{row.investor_type}</Badge>
                    {row.firm_name && row.firm_name !== row.name && (
                      <span>{row.firm_name}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      row.completeness_score >= 70
                        ? "default"
                        : row.completeness_score >= 40
                        ? "secondary"
                        : "outline"
                    }
                  >
                    Score {row.completeness_score}
                  </Badge>
                  <DialogPrimitive.Close
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label="Close" />
                    }
                  >
                    <XIcon className="size-4" />
                  </DialogPrimitive.Close>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                <div className="flex flex-col gap-5">
                  <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Fields
                    </h3>
                    <MissingFieldsRow missing={row.missing_fields} />
                  </section>

                  <OrchestratorBlock row={row} devMode={devMode} />

                  <ContactBlock row={row} />

                  {row.partners && row.partners.length > 0 && (
                    <section className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        People ({row.partners.length})
                      </h3>
                      <ul className="flex flex-col gap-1.5 text-sm">
                        {row.partners.map((p, i) => (
                          <li key={`${p.name}-${i}`} className="flex items-baseline gap-2">
                            <span className="font-medium">{p.name}</span>
                            {p.title && (
                              <span className="text-xs text-muted-foreground">
                                {p.title}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {row.portfolio_companies && row.portfolio_companies.length > 0 && (
                    <PortfolioBlock companies={row.portfolio_companies} />
                  )}

                  <section className="grid grid-cols-2 gap-4">
                    <Field label="Person">
                      {[row.person_first, row.person_last]
                        .filter(Boolean)
                        .join(" ") || "—"}
                    </Field>
                    <Field label="HQ country">{row.hq_country ?? "—"}</Field>
                    <Field label="HQ address" span={2}>
                      {row.hq_address ?? "—"}
                    </Field>
                    <Field label="Invests in" span={2}>
                      {row.countries_invest.length
                        ? row.countries_invest.join(", ")
                        : "—"}
                    </Field>
                    <Field label="Check size">
                      {formatCheck(row.check_min_usd, row.check_max_usd)}
                    </Field>
                    <Field label="Check bands">
                      {row.check_bands.length ? row.check_bands.join(", ") : "—"}
                    </Field>
                    <Field label="Sectors (L1)" span={2}>
                      {row.sectors_l1.length ? row.sectors_l1.join(", ") : "—"}
                    </Field>
                    <Field label="Sectors (L2)" span={2}>
                      {row.sectors_l2.length ? row.sectors_l2.join(", ") : "—"}
                    </Field>
                    <Field label="Stages" span={2}>
                      {row.stages.length ? row.stages.join(", ") : "—"}
                    </Field>
                    <Field label="# investments">
                      {row.num_investments_band ?? "—"}
                    </Field>
                    <Field label="Source">{row.source}</Field>
                  </section>

                  {row.thesis && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Thesis
                      </h3>
                      <p className="text-sm whitespace-pre-wrap">{row.thesis}</p>
                    </section>
                  )}

                  {row.x_voice_summary && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        X voice
                      </h3>
                      <blockquote className="border-l-2 border-sky-500/40 pl-3 text-sm italic text-foreground/80">
                        {row.x_voice_summary}
                      </blockquote>
                    </section>
                  )}

                  {row.x_recent_posts && row.x_recent_posts.length > 0 && (
                    <section className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Recent X posts ({row.x_recent_posts.length})
                      </h3>
                      <ul className="flex flex-col gap-2 text-sm">
                        {row.x_recent_posts.map((p, i) => (
                          <li
                            key={`${p.date}-${i}`}
                            className="flex gap-2"
                          >
                            <span className="w-20 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                              {p.date}
                            </span>
                            <span className="flex-1 whitespace-pre-wrap break-words">
                              {p.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {row.notes && (
                    <section>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Notes
                      </h3>
                      <p className="text-sm whitespace-pre-wrap">{row.notes}</p>
                    </section>
                  )}

                  <section className="grid grid-cols-2 gap-4 border-t pt-4 text-xs text-muted-foreground">
                    <Field label="ID">{row.id}</Field>
                    <Field label="Last enriched">
                      {row.last_enriched_at ?? "—"}
                    </Field>
                    <Field label="Steps run">{row.total_steps}</Field>
                    <Field label="Budget used (¢)">
                      {row.tool_budget_cents_used}
                    </Field>
                  </section>
                </div>
              </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
