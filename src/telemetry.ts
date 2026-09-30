// Connector-local Anthropic request/response log writer. The host's capture
// port owns storage and rotation; this module gates, redacts and hands over.
// (Relocated with the
// Anthropic adapter — llm-providers S4, cinatra#1715).
//
// The relocated adapter imports `writeAnthropicLogFile` from `../telemetry`
// (the SAME relative path it used in core `packages/llm/src/providers/anthropic.ts`
// → `packages/llm/src/telemetry.ts`), so the adapter body is byte-identical. Core
// keeps its own `telemetry.ts` copy (which also routes openai/gemini via the
// `llm-provider-surface` and exposes `writeLlmLogFile`) until the final
// core-deletion PR — only the ANTHROPIC writer + its dependency-light closure
// (log directory, redaction) are relocated here.
//
// LOGGING AUTHORITY (cinatra#1715 D2 — core PR #1969). The logging-`enabled`
// gate is STATELESS: it reads the persisted authority — the host connector-config
// key `anthropic-logging`, default-ENABLED unless an explicit `{enabled:false}` —
// through the connector's own host deps slot on EVERY call, never a
// connector-local module-state flag. That module state (the pre-#1969
// `logging-state.ts`, default-on) lived in a DIFFERENT realm than the host admin
// toggle once the adapter relocates, so the switch stopped reaching this writer
// (the split-brain the stage-1 artifact flagged). The flag now lives in the
// single connector-config authority both realms read: this mirrors core's
// `readAnthropicLoggingEnabledFromDatabase()` (src/lib/database.ts) and OpenAI's
// stateless connection-config-driven logging. The admin WRITE path
// (`saveAnthropicLoggingSettings` → the `anthropic-logging` key) stays host-side;
// this connector only READS. Default-ENABLED preserves the prior default-on
// behaviour exactly (absent/`{}` ⇒ true).

import { redactAuthorizationDeep } from "./log-redaction";
import { ANTHROPIC_LOG_CAPTURE_CHANNEL } from "./log-capture-channel";
import { getAnthropicDeps } from "./deps";

// The persisted-authority connector-config key holding the Anthropic
// request-logging `{ enabled }` flag. MUST equal core's
// `ANTHROPIC_LOGGING_CONFIG_KEY` (src/lib/database.ts) so both realms read the
// single authority the admin toggle writes.
export const ANTHROPIC_LOGGING_CONFIG_KEY = "anthropic-logging";

// Stateless read of the persisted logging-`enabled` authority, re-resolved via
// the host deps slot on every call — NO connector-local module-state flag
// (cinatra#1715 D2). Default-ENABLED: absent config / `{}` ⇒ true; only an
// explicit `enabled === false` disables. Matches core
// `readAnthropicLoggingEnabledFromDatabase()`.
export function isAnthropicLoggingEnabled(): boolean {
  const config = getAnthropicDeps().readConnectorConfigFromDatabase<{ enabled?: boolean }>(
    ANTHROPIC_LOGGING_CONFIG_KEY,
    {},
  );
  return config.enabled !== false;
}

export function getAnthropicLoggingSettings() {
  return {
    enabled: isAnthropicLoggingEnabled(),
    directory: getAnthropicDeps().captureLogDirectory?.(ANTHROPIC_LOG_CAPTURE_CHANNEL) ?? "",
  };
}

export async function writeAnthropicLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isAnthropicLoggingEnabled()) {
    return;
  }

  const rawContent = typeof input.body === "string" ? { raw: input.body } : input.body;
  // Strip Bearer tokens from MCP headers / authorization_token before the entry
  // leaves this connector. Provider request bodies carry the resolved
  // Authorization header for every injected MCP server.
  const content = redactAuthorizationDeep(rawContent);
  // The host's capture port owns storage: the directory, the file naming and
  // the rotation of old files.
  await getAnthropicDeps().captureLog?.(ANTHROPIC_LOG_CAPTURE_CHANNEL, {
    label: input.label,
    kind: input.kind,
    body: content,
  });
}
