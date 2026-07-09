// `register(ctx)` shape — the Stage 3 transport-DI inversion: register binds
// the host deps slot itself (always-bind since the post-cutover sweep, lazy per-call host
// service resolution, nango members over the connector-authored
// `nango-system` surface) and keeps registering the llm-provider-surface.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../index", () => ({
  getConfiguredAnthropicConnection: vi.fn(async () => null),
  getDefaultClaudeModel: vi.fn(() => "claude-x"),
  saveDefaultClaudeModel: vi.fn(),
  getPersistedDefaultClaudeModel: vi.fn(() => undefined),
  saveAnthropicAPISettings: vi.fn(async () => ({})),
  clearAnthropicAPISettings: vi.fn(async () => ({})),
  getAnthropicAPIStatus: vi.fn(() => ({ status: "not_connected", detail: "" })),
  getAnthropicSkillSyncCapabilityReady: vi.fn(() => false),
  saveAnthropicSkillSyncEnabled: vi.fn(async () => ({ ok: false, reason: "unavailable" })),
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
  // register(ctx) now ALSO registers the schema-config named actions via
  // `ctx.ui` (the "ui" host port) — provide a faithful ui port so this
  // deps-binding test exercises a complete ctx. (Named-action behavior is
  // asserted in register-ui-actions.test.ts.)
  const uiActions: Array<{ id: string; handler: (input: unknown) => Promise<unknown> }> = [];
  const ctx = {
    capabilities: {
      registerProvider: (capability: string, provider: unknown) => {
        registered.push({ capability, provider });
      },
      resolveProviders,
    },
    ui: {
      registerSetupSurface: () => {},
      registerSettingsSurface: () => {},
      registerAction: (action: { id: string; handler: (input: unknown) => Promise<unknown> }) => {
        uiActions.push(action);
      },
    },
  } as never;
  register(ctx);
  return { registered, resolveProviders, uiActions };
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

  // cinatra-ai/cinatra#1104 (S3a) is a SIBLING migration, not yet landed — this
  // is the ONE capability this connector resolves WITHOUT the fail-loud
  // hostService() pattern, since a host that predates #1104 legitimately has no
  // provider registered under this id.
  it('anthropicSkillConfig resolves null (never throws) when the "@cinatra-ai/host:anthropic-skill-config" capability is absent — fail-graceful pending cinatra-ai/cinatra#1104', () => {
    activateWithServices({});
    expect(getAnthropicDeps().anthropicSkillConfig).toBeNull();
  });

  it("anthropicSkillConfig resolves the LIVE provider once the host registers it, re-resolving on every access (lazy getter, not cached)", () => {
    const read = vi.fn(() => true);
    const write = vi.fn();
    const { resolveProviders } = activateWithServices({
      "@cinatra-ai/host:anthropic-skill-config": { read, write },
    });
    expect(getAnthropicDeps().anthropicSkillConfig?.read()).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    // Re-accessing the getter re-resolves via ctx (not a one-time snapshot) —
    // same lazy-getter contract as nango.providerConfigKeys/connectionIds.
    void getAnthropicDeps().anthropicSkillConfig;
    expect(resolveProviders).toHaveBeenCalledWith("@cinatra-ai/host:anthropic-skill-config");
  });

  it("anthropicSkillConfig resolves null when the registered provider is malformed (missing read/write)", () => {
    activateWithServices({ "@cinatra-ai/host:anthropic-skill-config": { read: () => true } }); // no write
    expect(getAnthropicDeps().anthropicSkillConfig).toBeNull();
  });
});
