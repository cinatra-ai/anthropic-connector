// Dependency-free leaf module holding the mutable Anthropic-logging enabled flag
// (relocated with the Anthropic adapter — llm-providers S4, cinatra#1715).
//
// DIVERGENCE FLAGGED TO THE COORDINATOR: in core this flag is toggled by
// `src/lib/logging.ts` `saveAnthropicLoggingSettings` (from the campaign-actions
// admin route) via core's `@cinatra-ai/llm/anthropic-logging-state`. This
// connector copy is a SEPARATE module instance — core's toggle does NOT reach
// it. Once the host resolves this connector's adapter, the adapter's log writer
// reads THIS flag (default-on), not the core-toggled one. Faithfully reconciling
// it (route the toggle connector-side, or migrate to a connection-config-driven
// enabled check like openai-connector) is a CORE-paired change beyond this
// connector-only lane. Relocated verbatim (default `true`) to preserve the exact
// current semantics; the split-brain is documented in the lane divergence report.

let anthropicLoggingEnabled = true;

export function setAnthropicLoggingEnabled(enabled: boolean): void {
  anthropicLoggingEnabled = enabled;
}

export function isAnthropicLoggingEnabled(): boolean {
  return anthropicLoggingEnabled;
}
