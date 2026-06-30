// register(ctx) registers the schema-config named actions via `ctx.ui` so the
// declarative setup surface (cinatra.configSchema) can probe readiness/status
// and save/clear the Anthropic connection WITHOUT shipping React (cinatra#782).
// The host dispatches these by id through
// `/api/extensions/{installId}/actions/{actionId}`, which authorizes the actor
// at the "use" tier host-side. Because a credential write is a MANAGE-tier
// mutation, the WRITE handlers (saveConnection/clearConnection) re-assert the
// manage gate via the host action-guard service — so a missing/denying guard
// FAILS CLOSED (the action throws; nothing executes ungated).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mocks exist before vi.mock's hoisted factory runs (a plain
// top-level const is initialized AFTER the hoisted mock factory).
const mocks = vi.hoisted(() => ({
  saveAnthropicAPISettings: vi.fn(async () => ({})),
  clearAnthropicAPISettings: vi.fn(async () => ({})),
  saveDefaultClaudeModel: vi.fn(),
  getAnthropicAPIStatus: vi.fn(() => ({ status: "not_connected", detail: "Add a key." })),
}));

vi.mock("../index", () => ({
  getConfiguredAnthropicConnection: vi.fn(async () => null),
  getDefaultClaudeModel: vi.fn(() => "claude-sonnet-4-6"),
  saveDefaultClaudeModel: mocks.saveDefaultClaudeModel,
  saveAnthropicAPISettings: mocks.saveAnthropicAPISettings,
  clearAnthropicAPISettings: mocks.clearAnthropicAPISettings,
  getAnthropicAPIStatus: mocks.getAnthropicAPIStatus,
  CLAUDE_MODELS: [
    "claude-opus-4-7",
    "claude-opus-4",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
}));

import { register } from "../register";
import { _resetAnthropicDepsForTests } from "../deps";

type RegisteredProvider = { packageName: string; impl: unknown };
type UiAction = { id: string; handler: (input: unknown) => Promise<unknown> };

function makeCtx(services: Record<string, unknown>) {
  const uiActions: UiAction[] = [];
  return {
    ctx: {
      capabilities: {
        registerProvider: () => {},
        resolveProviders: (capability: string): RegisteredProvider[] => {
          const svc = services[capability];
          return svc ? [{ packageName: "host", impl: svc }] : [];
        },
      },
      ui: {
        registerSetupSurface: () => {},
        registerSettingsSurface: () => {},
        registerAction: (action: UiAction) => {
          uiActions.push(action);
        },
      },
    } as unknown as Parameters<typeof register>[0],
    uiActions,
  };
}

function actionById(uiActions: UiAction[], id: string): UiAction {
  const a = uiActions.find((x) => x.id === id);
  if (!a) throw new Error(`action ${id} not registered`);
  return a;
}

// A minimal nango-system capability surface. register(ctx) always re-binds the
// deps slot (overwriting any pre-bound stub), and the deps' nango members
// resolve this capability LAZILY at call time — so the connectionServiceReady
// probe reaches isNangoConfigured() through the real activation path.
const NANGO_SYSTEM = { isNangoConfigured: () => true };

beforeEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});

afterEach(() => {
  _resetAnthropicDepsForTests();
});

describe("anthropic-connector register(ctx) — schema-config named actions", () => {
  it("registers the probe + write actions used by the configSchema", () => {
    const { ctx, uiActions } = makeCtx({});
    register(ctx);
    expect(uiActions.map((a) => a.id).sort()).toEqual(
      ["clearConnection", "connectionServiceReady", "connectionStatus", "saveConnection"].sort(),
    );
  });

  it("connectionServiceReady reports the nango readiness as data", async () => {
    const { ctx, uiActions } = makeCtx({ "nango-system": NANGO_SYSTEM });
    register(ctx);
    await expect(actionById(uiActions, "connectionServiceReady").handler({})).resolves.toEqual({
      ready: true,
    });
  });

  it("connectionStatus THROWS when not connected (so the probe pill shows error)", async () => {
    mocks.getAnthropicAPIStatus.mockReturnValueOnce({ status: "not_connected", detail: "Add a key." });
    const { ctx, uiActions } = makeCtx({});
    register(ctx);
    await expect(actionById(uiActions, "connectionStatus").handler({})).rejects.toThrow(/Add a key/);
  });

  it("connectionStatus returns the detail when connected", async () => {
    mocks.getAnthropicAPIStatus.mockReturnValueOnce({ status: "connected", detail: "Anthropic is configured." });
    const { ctx, uiActions } = makeCtx({});
    register(ctx);
    await expect(actionById(uiActions, "connectionStatus").handler({})).resolves.toEqual({
      detail: "Anthropic is configured.",
    });
  });

  it("saveConnection FAILS CLOSED when the action-guard service is missing (no write runs)", async () => {
    const { ctx, uiActions } = makeCtx({}); // no guard
    register(ctx);
    await expect(
      actionById(uiActions, "saveConnection").handler({ apiKey: "sk-ant-xyz" }),
    ).rejects.toThrow(/action-guard service is not registered/);
    expect(mocks.saveAnthropicAPISettings).not.toHaveBeenCalled();
  });

  it("saveConnection persists the key + model after the manage gate passes", async () => {
    const require = vi.fn(async () => {});
    const { ctx, uiActions } = makeCtx({
      "@cinatra-ai/host:extension-action-guard": { require },
    });
    register(ctx);
    const r = await actionById(uiActions, "saveConnection").handler({
      apiKey: "  sk-ant-xyz  ",
      defaultModel: "claude-opus-4",
    });
    expect(require).toHaveBeenCalledWith("@cinatra-ai/anthropic-connector", "manage");
    expect(mocks.saveAnthropicAPISettings).toHaveBeenCalledWith({ apiKey: "sk-ant-xyz" });
    expect(mocks.saveDefaultClaudeModel).toHaveBeenCalledWith("claude-opus-4");
    expect(r).toEqual({ banner: "saved" });
  });

  it("saveConnection treats a blank apiKey as ABSENT (no overwrite) and ignores an unknown model", async () => {
    const { ctx, uiActions } = makeCtx({
      "@cinatra-ai/host:extension-action-guard": { require: vi.fn(async () => {}) },
    });
    register(ctx);
    await actionById(uiActions, "saveConnection").handler({ apiKey: "   ", defaultModel: "gpt-5" });
    expect(mocks.saveAnthropicAPISettings).not.toHaveBeenCalled();
    expect(mocks.saveDefaultClaudeModel).not.toHaveBeenCalled();
  });

  it("clearConnection clears after the manage gate, and FAILS CLOSED without the guard", async () => {
    const noGuard = makeCtx({});
    register(noGuard.ctx);
    await expect(actionById(noGuard.uiActions, "clearConnection").handler({})).rejects.toThrow(
      /action-guard service is not registered/,
    );
    expect(mocks.clearAnthropicAPISettings).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const require = vi.fn(async () => {});
    const withGuard = makeCtx({ "@cinatra-ai/host:extension-action-guard": { require } });
    register(withGuard.ctx);
    const r = await actionById(withGuard.uiActions, "clearConnection").handler({});
    expect(require).toHaveBeenCalledWith("@cinatra-ai/anthropic-connector", "manage");
    expect(mocks.clearAnthropicAPISettings).toHaveBeenCalledOnce();
    expect(r).toEqual({ banner: "cleared" });
  });
});
