// Logging-authority contract for the relocated Anthropic log writer
// (cinatra#1715 D2, core PR #1969). The logging-`enabled` gate MUST be STATELESS:
// read from the persisted authority — the host connector-config key
// `anthropic-logging`, default-ENABLED unless an explicit `{enabled:false}` — via
// the host deps slot on EVERY call, never a connector-local module-state flag.
// Mirrors core's `readAnthropicLoggingEnabledFromDatabase()` contract so both
// realms agree on the single authority the admin toggle writes.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_LOGGING_CONFIG_KEY,
  isAnthropicLoggingEnabled,
  getAnthropicLoggingSettings,
} from "../telemetry";
import { ANTHROPIC_API_LOG_DIRECTORY } from "../log-directory";
import { registerAnthropicConnector, _resetAnthropicDepsForTests } from "../deps";

/** Bind a deps slot whose connector-config read returns `value` for the
 *  `anthropic-logging` key (and the caller's fallback for anything else). */
function bindLoggingConfig(value: unknown, capture?: (key: string) => void) {
  const read = vi.fn(<T>(connectorId: string, fallback: T): T => {
    capture?.(connectorId);
    if (connectorId === ANTHROPIC_LOGGING_CONFIG_KEY) return (value ?? fallback) as T;
    return fallback;
  });
  registerAnthropicConnector({ readConnectorConfigFromDatabase: read } as never);
  return read;
}

afterEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});

describe("Anthropic logging authority (cinatra#1715 D2) — stateless persisted read", () => {
  it("the config key equals core's ANTHROPIC_LOGGING_CONFIG_KEY", () => {
    expect(ANTHROPIC_LOGGING_CONFIG_KEY).toBe("anthropic-logging");
  });

  it("defaults ENABLED when the key is absent/empty or explicitly `{enabled:true}`", () => {
    bindLoggingConfig({});
    expect(isAnthropicLoggingEnabled()).toBe(true);
    bindLoggingConfig(undefined);
    expect(isAnthropicLoggingEnabled()).toBe(true);
    bindLoggingConfig({ enabled: true });
    expect(isAnthropicLoggingEnabled()).toBe(true);
  });

  it("is DISABLED only by an explicit `{enabled:false}`", () => {
    bindLoggingConfig({ enabled: false });
    expect(isAnthropicLoggingEnabled()).toBe(false);
  });

  it("reads the persisted `anthropic-logging` connector-config key (never module state)", () => {
    const keys: string[] = [];
    bindLoggingConfig({ enabled: false }, (k) => keys.push(k));
    isAnthropicLoggingEnabled();
    expect(keys).toContain("anthropic-logging");
  });

  it("re-reads on EVERY call (stateless — a later persisted change is honoured immediately, no cache)", () => {
    let stored: unknown = { enabled: true };
    const read = vi.fn(<T>(connectorId: string, fallback: T): T =>
      connectorId === ANTHROPIC_LOGGING_CONFIG_KEY ? ((stored ?? fallback) as T) : fallback,
    );
    registerAnthropicConnector({ readConnectorConfigFromDatabase: read } as never);
    expect(isAnthropicLoggingEnabled()).toBe(true);
    stored = { enabled: false };
    expect(isAnthropicLoggingEnabled()).toBe(false);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("getAnthropicLoggingSettings() reports the enabled flag + the anthropic log directory", () => {
    bindLoggingConfig({ enabled: false });
    const settings = getAnthropicLoggingSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.directory).toBe(ANTHROPIC_API_LOG_DIRECTORY);
  });
});
