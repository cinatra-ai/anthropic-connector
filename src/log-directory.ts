import path from "node:path";

// Dependency-free leaf module (relocated with the Anthropic adapter —
// llm-providers S4, cinatra#1715). Kept apart from telemetry.ts to break the
// ESM module-init cycle the same way the core copy documents (a barrel that
// evaluates telemetry.ts at module-init must not re-enter before this const is
// initialized).
export const ANTHROPIC_API_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "anthropic-api");
