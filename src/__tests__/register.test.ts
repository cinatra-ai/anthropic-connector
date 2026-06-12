// `register(ctx)` shape — the Stage 3 transport-DI inversion: register binds
// the host deps slot itself (always-bind since the post-cutover sweep, lazy per-call host
// service resolution, nango members over the connector-authored
// `nango-system` surface) and keeps registering the llm-provider-surface.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../index", () => ({
  getConfiguredAnthropicConnection: vi.fn(async () => null),
  getDefaultClaudeModel: vi.fn(() => "claude-x"),
  saveDefaultClaudeModel: vi.fn(),
  saveAnthropicAPISettings: vi.fn(async () => ({})),
  clearAnthropicAPISettings: vi.fn(async () => ({})),
  CLAUDE_MODELS: ["claude-x"],
}));

import { register } from "../register";
import {
  getAnthropicDeps,
  registerAnthropicConnector,
  _resetAnthropicDepsForTests,
} from "../deps";

function activateWithServices(impls: Record<string, unknown>) {
  const registered: Array<{ capability: string; provider: unknown }> = [];
  const resolveProviders = vi.fn((capability: string) =>
    impls[capability] !== undefined
      ? [{ packageName: "@cinatra-ai/host", impl: impls[capability] }]
      : [],
  );
  const ctx = {
    capabilities: {
      registerProvider: (capability: string, provider: unknown) => {
        registered.push({ capability, provider });
      },
      resolveProviders,
    },
  } as never;
  register(ctx);
  return { registered, resolveProviders };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});

describe("register(ctx) — transport-DI deps binding (Stage 3)", () => {
  it("binds the deps slot when absent, resolving host services LAZILY at call time", () => {
    const isDevelopment = vi.fn(() => true);
    const { registered, resolveProviders } = activateWithServices({
      "@cinatra-ai/host:runtime-mode": { isDevelopment },
    });
    // The llm-provider-surface registration is unchanged.
    expect(registered.map((r) => r.capability)).toContain("llm-provider-surface");
    // No host-service resolution happened at registration (probe-safe).
    expect(resolveProviders).not.toHaveBeenCalled();
    expect(getAnthropicDeps().isAppDevelopmentMode()).toBe(true);
    expect(isDevelopment).toHaveBeenCalledTimes(1);
  });

  it("REPLACES a pre-bound deps slot (always-bind — a hot-update digest swap re-binds fresh resolvers)", () => {
    const sentinel = vi.fn(() => false);
    registerAnthropicConnector({ isAppDevelopmentMode: sentinel } as never);
    activateWithServices({ "@cinatra-ai/host:runtime-mode": { isDevelopment: () => true } });
    expect(getAnthropicDeps().isAppDevelopmentMode()).toBe(true);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("nango members delegate to the connector-authored nango-system surface", () => {
    const isNangoConfigured = vi.fn(() => true);
    const getNangoStatus = vi.fn(() => ({ status: "connected", detail: "" }));
    activateWithServices({
      "nango-system": {
        isNangoConfigured,
        getNangoStatus,
        providerConfigKeys: { claude: "cinatra-claude" },
      },
    });
    expect(getAnthropicDeps().nango.isConfigured()).toBe(true);
    expect(getAnthropicDeps().nango.getStatus().status).toBe("connected");
    expect(getAnthropicDeps().nango.providerConfigKeys.claude).toBe("cinatra-claude");
  });

  it("fails LOUD (descriptive) on a missing host service at call time", () => {
    activateWithServices({});
    expect(() => getAnthropicDeps().readAnthropicConnectionFromDatabase()).toThrow(
      /host service "@cinatra-ai\/host:anthropic-connection" is not registered/,
    );
    expect(() => getAnthropicDeps().nango.isConfigured()).toThrow(/nango-system/);
  });
});
