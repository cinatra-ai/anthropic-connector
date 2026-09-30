// The request/response log writer stores nothing itself: after its stateless
// logging gate and the Authorization redaction it hands the entry to the host's
// capture port, which owns the directory, the file naming and the rotation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_LOGGING_CONFIG_KEY, getAnthropicLoggingSettings, writeAnthropicLogFile } from "../telemetry";
import { registerAnthropicConnector, _resetAnthropicDepsForTests } from "../deps";

const CHANNEL = "anthropic-api";

function bindDeps(options: { enabled?: boolean; withCapture?: boolean }) {
  const captureLog = vi.fn(async (_channel: string, _entry: { label: string; kind: string; body: unknown }) => {});
  const captureLogDirectory = vi.fn((channel: string) => `host-root/logs/${channel}`);
  const read = <T>(key: string, fallback: T): T =>
    key === ANTHROPIC_LOGGING_CONFIG_KEY && options.enabled === false ? ({ enabled: false } as T) : fallback;
  registerAnthropicConnector({
    readConnectorConfigFromDatabase: read,
    ...(options.withCapture === false ? {} : { captureLog, captureLogDirectory }),
  } as never);
  return { captureLog, captureLogDirectory };
}

afterEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});

describe("Anthropic request logs go through the host's capture port", () => {
  it("C1: with logging enabled, captures once on the channel with the redacted body", async () => {
    const { captureLog } = bindDeps({});
    await writeAnthropicLogFile({
      label: "call-1",
      kind: "request",
      body: { headers: { Authorization: "Bearer test-token" }, input: "hello" },
    });
    expect(captureLog).toHaveBeenCalledTimes(1);
    expect(captureLog).toHaveBeenCalledWith(CHANNEL, {
      label: "call-1",
      kind: "request",
      body: { headers: { Authorization: "[REDACTED]" }, input: "hello" },
    });
  });

  it("C2: with logging disabled, never captures", async () => {
    const { captureLog } = bindDeps({ enabled: false });
    await writeAnthropicLogFile({ label: "call-1", kind: "response", body: { ok: true } });
    expect(captureLog).not.toHaveBeenCalled();
  });

  it("C3: the settings directory is what the host resolves for the channel", () => {
    const { captureLogDirectory } = bindDeps({});
    expect(getAnthropicLoggingSettings().directory).toBe(captureLogDirectory(CHANNEL));
    expect(getAnthropicLoggingSettings().directory).toBe(`host-root/logs/${CHANNEL}`);
  });

  it("C4: a deps slot without the capture port resolves and throws nothing", async () => {
    bindDeps({ withCapture: false });
    await expect(writeAnthropicLogFile({ label: "call-1", kind: "request", body: "text" })).resolves.toBeUndefined();
  });
});
