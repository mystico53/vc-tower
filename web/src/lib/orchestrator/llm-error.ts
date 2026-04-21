import { classifyUpstreamError } from "@/lib/tools/classify-error";
import type { ToolErrorKind } from "@/lib/tools/types";

// Normalizes OpenAI SDK errors (used against Dashscope for decide + extract)
// into a shape runOneStep can match on to trip the global pause. Only
// credit/auth/rate_limit statuses get wrapped — plain 400s or parse bugs stay
// as their original error and fall through to the step's error path.
export class LLMUpstreamError extends Error {
  constructor(
    public stage: "decide" | "extract",
    public status: number,
    public error_kind: ToolErrorKind,
    body: string,
  ) {
    super(`${stage} dashscope ${status}: ${body.slice(0, 300)}`);
    this.name = "LLMUpstreamError";
  }
}

// Call around every Dashscope chat.completions call. If `e` looks like an
// upstream credit/auth/rate_limit error, throws LLMUpstreamError; otherwise
// rethrows the original so prompt/parse bugs still surface cleanly.
export function rethrowIfUpstream(stage: "decide" | "extract", e: unknown): never {
  if (e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number") {
    const status = (e as { status: number }).status;
    const body = ((e as { message?: unknown }).message ?? "").toString();
    const kind = classifyUpstreamError(status, body);
    if (kind === "credit" || kind === "auth" || kind === "rate_limit") {
      throw new LLMUpstreamError(stage, status, kind, body);
    }
  }
  throw e as Error;
}
