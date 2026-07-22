// Executable coverage for the relocated `llm-provider-adapter` surface
// registration (llm-providers S4 — cinatra#1715). The extension-kind-gate
// asserts the registration SHAPE textually; this proves the runtime WIRING:
// the surface is registered with the connector's own providerId + ABI v1,
// registration does no host I/O (probe-safe), createAdapter() fails CLOSED to
// null when the connector is present-but-unconfigured, and a configured
// connection reaches `createAnthropicProviderAdapter`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.hoisted` so these mock fns exist when the hoisted `vi.mock` factories run.
const { getConfiguredAnthropicConnectionMock, createAnthropicProviderAdapterMock } = vi.hoisted(
  () => ({
    getConfiguredAnthropicConnectionMock: vi.fn(),
    createAnthropicProviderAdapterMock: vi.fn(),
  }),
);

vi.mock("../index", () => ({
  getConfiguredAnthropicConnection: getConfiguredAnthropicConnectionMock,
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

// Isolate the wiring from the adapter internals (the real factory eagerly
// constructs the Anthropic SDK client).
vi.mock("../adapter/anthropic-adapter", () => ({
  createAnthropicProviderAdapter: createAnthropicProviderAdapterMock,
}));

import { register } from "../register";
import { _resetAnthropicDepsForTests } from "../deps";

type Registered = { capability: string; provider: { packageName: string; impl: unknown } };

function activate() {
  const registered: Registered[] = [];
  const resolveProviders = vi.fn(() => [] as Array<{ packageName: string; impl: unknown }>);
  const ctx = {
    capabilities: {
      registerProvider: (capability: string, provider: { packageName: string; impl: unknown }) => {
        registered.push({ capability, provider });
      },
      resolveProviders,
    },
    ui: {
      registerSetupSurface: () => {},
      registerSettingsSurface: () => {},
      registerAction: () => {},
    },
  } as never;
  register(ctx);
  return { registered, resolveProviders };
}

type AdapterSurface = {
  abiVersion: number;
  providerId: string;
  createAdapter: () => Promise<unknown>;
};

function adapterSurface(registered: Registered[]): AdapterSurface | undefined {
  const entry = registered.find((r) => r.capability === "llm-provider-adapter");
  return entry?.provider.impl as AdapterSurface | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});

describe("register(ctx) — llm-provider-adapter surface (llm-providers S4, cinatra#1715)", () => {
  it("registers the versioned adapter surface with the connector's own providerId + ABI v1", () => {
    const { registered } = activate();
    const surface = adapterSurface(registered);
    expect(surface).toBeDefined();
    expect(surface!.abiVersion).toBe(1);
    expect(surface!.providerId).toBe("anthropic");
    expect(typeof surface!.createAdapter).toBe("function");
  });

  it("registration is probe-safe — no connection resolution or adapter construction at register() time", () => {
    activate();
    expect(getConfiguredAnthropicConnectionMock).not.toHaveBeenCalled();
    expect(createAnthropicProviderAdapterMock).not.toHaveBeenCalled();
  });

  it("createAdapter() returns null (fail-closed) when the connector is present-but-unconfigured", async () => {
    getConfiguredAnthropicConnectionMock.mockResolvedValue(null);
    const { registered } = activate();
    const surface = adapterSurface(registered)!;
    await expect(surface.createAdapter()).resolves.toBeNull();
    expect(createAnthropicProviderAdapterMock).not.toHaveBeenCalled();
  });

  it("createAdapter() builds the adapter from the resolved connection when configured", async () => {
    const connection = { apiKey: "sk-ant-test", defaultModel: "claude-x", promptCachingEnabled: false };
    const built = { __adapter: true };
    getConfiguredAnthropicConnectionMock.mockResolvedValue(connection);
    createAnthropicProviderAdapterMock.mockReturnValue(built);
    const { registered } = activate();
    const surface = adapterSurface(registered)!;
    const adapter = await surface.createAdapter();
    expect(createAnthropicProviderAdapterMock).toHaveBeenCalledWith(connection);
    expect(adapter).toBe(built);
  });
});
