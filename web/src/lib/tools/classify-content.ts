import type { ToolErrorKind } from "./types";

// Classify a page that loaded "successfully" (HTTP 200, origin not error)
// but whose markdown is practically useless. Firecrawl/Jina can't tell these
// apart from real content, so the orchestrator ends up burning a whole
// dead-site-early-stop cycle (2 consecutive zero-extraction steps) before
// giving up. Classifying here lets decide() pivot tools on the first hit.
//
// Returns null when the content looks usable — caller should treat that as
// a successful scrape. Returns a ToolErrorKind ("auth_wall" | "js_required"
// | "empty_content") when the content is unusable, in priority order:
//
//   auth_wall    : the page explicitly prompts the user to log in / subscribe
//                  and has little other content. A re-scrape won't fix this.
//   js_required  : the page visibly calls out that JavaScript is needed.
//                  Firecrawl without the JS rendering add-on can't help.
//   empty_content: catch-all for short markdown — redirect stubs, empty
//                  Squarespace placeholders, pages that rendered only a nav.
//
// None of these kinds trip the global pause — they're per-step signals. The
// orchestrator reads them and pivots to a different tool or stops the row.

const EMPTY_THRESHOLD = 200; // chars of "real" content below which the page is useless
const JS_BODY_THRESHOLD = 1000; // js_required only trips when content is short-ish
const AUTH_BODY_THRESHOLD = 1500; // auth_wall likewise — a long article that happens to mention "sign in" is fine

const AUTH_WALL_RE = /\b(?:sign[\s-]?in|log[\s-]?in|subscribe to read|create an account|members? only|please log in|please sign in|paywall|become a member)\b/i;
const JS_REQUIRED_RE = /\b(?:enable javascript|javascript is (?:disabled|required)|please enable javascript|this (?:site|app|page) requires javascript|you need javascript|noscript)\b/i;

// Strip markdown syntax + whitespace to get the "real" text the extractor
// would actually see. Images are dropped entirely; link text is preserved
// but the URL is not — otherwise a footer link to `.../login` makes every
// page look paywalled, and a nav-heavy page (labels inside `[text](url)`)
// looks artificially short.
function visibleText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")            // code fences
    .replace(/`[^`]*`/g, " ")                    // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")       // images: drop entirely
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // links: keep text, drop URL
    .replace(/<[^>]+>/g, " ")                    // html tags
    .replace(/[#*_~>`|\-]+/g, " ")                // md chrome
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyContent(markdown: string | null | undefined): ToolErrorKind | null {
  if (typeof markdown !== "string") return null;
  const visible = visibleText(markdown);
  const realLen = visible.length;

  // Short-circuit: content is long enough to be real.
  if (realLen >= AUTH_BODY_THRESHOLD) return null;

  // auth_wall: explicit login/paywall prompt AND not much else. Checked
  // first because a page can have "sign in" + a JS-required banner + be
  // short; login is the most actionable signal for the orchestrator.
  // Test against visible text so "login" inside a URL doesn't count.
  if (AUTH_WALL_RE.test(visible) && realLen < AUTH_BODY_THRESHOLD) {
    return "auth_wall";
  }

  // js_required: the page says so. Don't require shortness as hard here —
  // a page that says "enable javascript" and has nothing else is js_required
  // even if the body is technically > EMPTY_THRESHOLD after markdown chrome.
  if (JS_REQUIRED_RE.test(visible) && realLen < JS_BODY_THRESHOLD) {
    return "js_required";
  }

  // Catch-all for too-short markdown that didn't match the specific kinds.
  if (realLen < EMPTY_THRESHOLD) {
    return "empty_content";
  }

  return null;
}
