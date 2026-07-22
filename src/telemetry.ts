// Connector-local Anthropic request/response log writer (relocated with the
// Anthropic adapter — llm-providers S4, cinatra#1715).
//
// The relocated adapter imports `writeAnthropicLogFile` from `../telemetry`
// (the SAME relative path it used in core `packages/llm/src/providers/anthropic.ts`
// → `packages/llm/src/telemetry.ts`), so the adapter body is byte-identical. Core
// keeps its own `telemetry.ts` copy (which also routes openai/gemini via the
// `llm-provider-surface` and exposes `writeLlmLogFile`) until the final
// core-deletion PR — only the ANTHROPIC writer + its dependency-light closure
// (log directory, redaction, enabled-flag) are relocated here.
//
// The logging-enabled gate reads the connector-local `./logging-state` flag; see
// that module's divergence note (core's admin toggle does not reach this copy).

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { redactAuthorizationDeep } from "./log-redaction";
import { ANTHROPIC_API_LOG_DIRECTORY } from "./log-directory";
import { isAnthropicLoggingEnabled } from "./logging-state";

const MAX_ANTHROPIC_LOG_FILES = 200;

export function getAnthropicLoggingSettings() {
  return {
    enabled: isAnthropicLoggingEnabled(),
    directory: ANTHROPIC_API_LOG_DIRECTORY,
  };
}

function sanitizeLogLabel(value: string) {
  // Collapse non-alphanumeric runs to a single dash (linear global replace), then
  // trim leading/trailing dashes with a bounded scan instead of the anchored
  // `/^-+|-+$/g` regex, which CodeQL flags as polynomial-ReDoS on dash-heavy input
  // (js/polynomial-redos). The char-scan trim is O(n) with no backtracking.
  const collapsed = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 45 /* '-' */) start++;
  while (end > start && collapsed.charCodeAt(end - 1) === 45 /* '-' */) end--;
  return collapsed.slice(start, end).slice(0, 80) || "anthropic-call";
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeAnthropicLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isAnthropicLoggingEnabled()) {
    return;
  }

  await mkdir(ANTHROPIC_API_LOG_DIRECTORY, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  const rawContent = typeof input.body === "string" ? { raw: input.body } : input.body;
  // Strip Bearer tokens from MCP headers / authorization_token before they hit
  // disk. Provider request bodies carry the resolved Authorization header for
  // every injected MCP server.
  const content = redactAuthorizationDeep(rawContent);
  await writeFile(path.join(ANTHROPIC_API_LOG_DIRECTORY, filename), JSON.stringify(content, null, 2), "utf8");

  // Non-blocking log rotation — prune oldest files when over limit.
  // Runs asynchronously to avoid slowing down the API call path.
  void pruneAnthropicLogs().catch(() => {});
}

async function pruneAnthropicLogs() {
  const entries = await readdir(ANTHROPIC_API_LOG_DIRECTORY);
  if (entries.length <= MAX_ANTHROPIC_LOG_FILES) return;

  // Files are named with ISO timestamps, so alphabetical sort = chronological order.
  const sorted = entries.filter(e => e.endsWith(".json")).sort();
  const toRemove = sorted.slice(0, sorted.length - MAX_ANTHROPIC_LOG_FILES);
  await Promise.all(
    toRemove.map(f => rm(path.join(ANTHROPIC_API_LOG_DIRECTORY, f), { force: true })),
  );
}
