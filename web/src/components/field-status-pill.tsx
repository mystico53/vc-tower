import { cn } from "@/lib/utils";

type Status = "missing" | "filled" | "pending";

// One pill per field. Compact visual — used in the row table to show
// what still needs enrichment at a glance.
export function FieldStatusPill({
  label,
  status,
  className,
}: {
  label: string;
  status: Status;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums",
        status === "filled" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        status === "missing" &&
          "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
        status === "pending" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className,
      )}
      title={`${label}: ${status}`}
    >
      {label}
    </span>
  );
}

const FIELD_LABELS: Record<string, string> = {
  stages: "stage",
  sectors: "sector",
  check_range: "check",
  thesis: "thesis",
  any_contact: "contact",
  geo: "geo",
};

export function MissingFieldsRow({
  missing,
}: {
  missing: readonly string[];
}) {
  const all = Object.keys(FIELD_LABELS);
  const missingSet = new Set(missing);
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((f) => (
        <FieldStatusPill
          key={f}
          label={FIELD_LABELS[f]}
          status={missingSet.has(f) ? "missing" : "filled"}
        />
      ))}
    </div>
  );
}
