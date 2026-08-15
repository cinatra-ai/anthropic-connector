/**
 * cinatra#2776 item 3(e) — the reported MCP mode must equal the DISPATCHED one.
 *
 * `getConfiguredAnthropicConnection()` omits `mcpMode` when nothing is stored,
 * so the adapter receives `undefined` and resolves its own effective default:
 * `"native"`. `getMcpMode()` used to answer `"function-tools"` for that same
 * unset setting, so the readiness/probe surface described a mode dispatch never
 * used — the native-skills probe refused before egress on a connection that
 * would have issued a perfectly good native `container.skills` request.
 *
 * These pin BOTH halves: the unset default, and that an explicitly saved value
 * is still honoured verbatim in both directions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMcpMode, saveMcpMode, getConfiguredAnthropicConnection } from "../index";
import {
  registerAnthropicConnector,
  _resetAnthropicDepsForTests,
  type AnthropicConnectorDeps,
} from "../deps";

function makeDeps(settings: Record<string, unknown>) {
  const store: Record<string, unknown> = { anthropic: settings, anthropic_connection: null };
  const deps = {
    readConnectorConfigFromDatabase: <T>(connectorId: string, fallback: T): T =>
      (connectorId in store ? (store[connectorId] as T) : fallback) ?? fallback,
    writeConnectorConfigToDatabase: vi.fn((connectorId: string, value: unknown) => {
      store[connectorId] = value;
    }),
    deleteConnectorConfigFromDatabase: vi.fn(),
    readAnthropicConnectionFromDatabase: vi.fn(() => ({ apiKey: "sk-ant-test" })),
    isAppDevelopmentMode: vi.fn(() => false),
    nango: {
      isConfigured: vi.fn(() => false),
      getPrimarySavedConnection: vi.fn(() => null),
      getCredentials: vi.fn(async () => null),
      providerConfigKeys: { claude: "cinatra-claude" },
      connectionIds: { claude: "workspace" },
    },
    anthropicSkillConfig: { read: vi.fn(() => false), write: vi.fn() },
  } as unknown as AnthropicConnectorDeps;
  registerAnthropicConnector(deps);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});
afterEach(() => {
  _resetAnthropicDepsForTests();
});

describe("getMcpMode — the unset default matches the adapter's effective default", () => {
  it("reports 'native' when nothing is stored (was 'function-tools' — the readiness/dispatch split)", () => {
    makeDeps({});
    expect(getMcpMode()).toBe("native");
  });

  it("the connection object still OMITS mcpMode when unset, so the adapter resolves its own default", async () => {
    makeDeps({});
    const connection = await getConfiguredAnthropicConnection();
    expect(connection).not.toBeNull();
    expect(connection).not.toHaveProperty("mcpMode");
    // The probe's resolution order — connection.mcpMode ?? getMcpMode() — now
    // lands on the same value the adapter dispatches with.
    expect(connection?.mcpMode ?? getMcpMode()).toBe("native");
  });

  it("an explicitly saved 'function-tools' is honoured verbatim", () => {
    makeDeps({ mcpMode: "function-tools" });
    expect(getMcpMode()).toBe("function-tools");
  });

  it("an explicitly saved 'native' is honoured verbatim", () => {
    makeDeps({ mcpMode: "native" });
    expect(getMcpMode()).toBe("native");
  });

  it("saveMcpMode round-trips both values", () => {
    makeDeps({});
    saveMcpMode("function-tools");
    expect(getMcpMode()).toBe("function-tools");
    saveMcpMode("native");
    expect(getMcpMode()).toBe("native");
  });
});
