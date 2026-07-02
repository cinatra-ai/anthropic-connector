// Credential-lifecycle unit tests for the anthropic connector's index.ts:
//   - verify-before-persist: import WITHOUT the auto-pointer, forceRefresh
//     readback compare, save the pointer ONLY on match;
//   - pointer-gated read: getConfiguredAnthropicConnection never reads a Nango
//     credential without a saved pointer (no deterministic fallback);
//   - full disconnect on clear: the legacy `anthropic_connection` DB-fallback
//     row is physically purged (even if the Nango deletion fails);
//   - status consults the legacy fallback so it matches real behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfiguredAnthropicConnection,
  saveAnthropicAPISettings,
  clearAnthropicAPISettings,
  getAnthropicAPIStatus,
} from "../index";
import {
  registerAnthropicConnector,
  _resetAnthropicDepsForTests,
  type AnthropicConnectorDeps,
} from "../deps";

const PCK = "cinatra-claude";
const CID = "workspace";

type SavedConn = { providerConfigKey: string; connectionId: string; displayName?: string } | null;

function makeDeps(opts: {
  configured?: boolean;
  savedConnection?: SavedConn;
  credentials?: unknown; // what getCredentials returns (readback + read)
  dbRow?: { apiKey?: string } | null; // legacy anthropic_connection fallback row
  settings?: Record<string, unknown>; // the connector_config "anthropic" row
  deleteConnectionImpl?: () => Promise<unknown>;
}) {
  const store: Record<string, unknown> = {
    anthropic: opts.settings ?? {},
    anthropic_connection: opts.dbRow ?? null,
  };
  let savedConnection: SavedConn = opts.savedConnection ?? null;

  const nango = {
    isConfigured: vi.fn(() => opts.configured ?? true),
    getStatus: vi.fn(() => ({ status: "connected" as const, detail: "" })),
    getFrontendConfig: vi.fn(() => ({})),
    getPrimarySavedConnection: vi.fn((_key: "claude") => savedConnection),
    getCredentials: vi.fn(async (_pck: string, _cid: string, _opts?: { forceRefresh?: boolean }) =>
      opts.credentials ?? null,
    ),
    saveConnectionRecord: vi.fn(
      async (_key: "claude", record: { connectionId: string; providerConfigKey: string }) => {
        savedConnection = { providerConfigKey: record.providerConfigKey, connectionId: record.connectionId };
      },
    ),
    ensureIntegration: vi.fn(async () => ({})),
    importConnection: vi.fn(async (_input: Record<string, unknown>) => ({})),
    deleteConnection: vi.fn(opts.deleteConnectionImpl ?? (async () => ({}))),
    clearConnectionRecords: vi.fn(async (_key: "claude") => {
      savedConnection = null;
    }),
    providerConfigKeys: { claude: PCK },
    connectionIds: { claude: CID },
  };

  const deps = {
    readConnectorConfigFromDatabase: <T>(connectorId: string, fallback: T): T =>
      (connectorId in store ? (store[connectorId] as T) : fallback) ?? fallback,
    writeConnectorConfigToDatabase: vi.fn((connectorId: string, value: unknown) => {
      store[connectorId] = value;
    }),
    deleteConnectorConfigFromDatabase: vi.fn((connectorId: string) => {
      delete store[connectorId];
    }),
    readAnthropicConnectionFromDatabase: vi.fn(
      () => (store.anthropic_connection ?? null) as { apiKey?: string } | null,
    ),
    isAppDevelopmentMode: vi.fn(() => false),
    nango,
  } as unknown as AnthropicConnectorDeps;

  registerAnthropicConnector(deps);
  return { deps, nango, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAnthropicDepsForTests();
});
afterEach(() => {
  _resetAnthropicDepsForTests();
});

describe("getConfiguredAnthropicConnection — pointer-gated read (finding 1)", () => {
  it("returns null when Nango is configured but there is NO saved pointer and no DB fallback — and never reads a credential", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: null,
      // A credential is present at the deterministic keys, but with no pointer
      // it must NOT be read/returned (the removed deterministic fallback).
      credentials: { apiKey: "sk-must-not-read" },
      dbRow: null,
    });
    await expect(getConfiguredAnthropicConnection()).resolves.toBeNull();
    expect(nango.getCredentials).not.toHaveBeenCalled();
  });

  it("reads the credential ONLY through the saved pointer's keys", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: "pck-1", connectionId: "cid-1" },
      credentials: { apiKey: "sk-ant-live" },
    });
    await expect(getConfiguredAnthropicConnection()).resolves.toMatchObject({ apiKey: "sk-ant-live" });
    expect(nango.getCredentials).toHaveBeenCalledWith("pck-1", "cid-1");
  });

  it("falls back to the legacy DB row when there is no Nango pointer", async () => {
    makeDeps({ configured: true, savedConnection: null, dbRow: { apiKey: "sk-legacy" } });
    await expect(getConfiguredAnthropicConnection()).resolves.toMatchObject({ apiKey: "sk-legacy" });
  });
});

describe("saveAnthropicAPISettings — verify-before-persist (finding 1)", () => {
  it("imports WITHOUT connectorKey, verifies the readback, THEN saves the pointer and purges the legacy row", async () => {
    const { nango, deps } = makeDeps({
      configured: true,
      savedConnection: null,
      credentials: { apiKey: "sk-new" },
      dbRow: { apiKey: "sk-legacy" },
    });
    await saveAnthropicAPISettings({ apiKey: "  sk-new  " });

    expect(nango.importConnection).toHaveBeenCalledTimes(1);
    const importArg = nango.importConnection.mock.calls[0][0];
    expect("connectorKey" in importArg).toBe(false);
    expect(importArg.credentials).toEqual({ type: "API_KEY", apiKey: "sk-new" });

    expect(nango.getCredentials).toHaveBeenCalledWith(PCK, CID, { forceRefresh: true });
    expect(nango.saveConnectionRecord).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ connectionId: CID, providerConfigKey: PCK }),
      { multiple: false },
    );
    // Pointer commit happens strictly AFTER the import + readback.
    expect(nango.saveConnectionRecord.mock.invocationCallOrder[0]).toBeGreaterThan(
      nango.importConnection.mock.invocationCallOrder[0],
    );
    expect(nango.saveConnectionRecord.mock.invocationCallOrder[0]).toBeGreaterThan(
      nango.getCredentials.mock.invocationCallOrder[0],
    );
    // The legacy plaintext fallback is purged on a verified save.
    expect(deps.deleteConnectorConfigFromDatabase).toHaveBeenCalledWith("anthropic_connection");
  });

  it("THROWS on a readback mismatch, rolls back (deletes the credential + drops the pointer), and does NOT save a pointer; the message carries no token", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: null,
      credentials: { apiKey: "sk-DIFFERENT" },
    });
    await expect(saveAnthropicAPISettings({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    expect(nango.saveConnectionRecord).not.toHaveBeenCalled();
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("claude");
    // No usable credential is reachable: no pointer was committed.
    await expect(getConfiguredAnthropicConnection()).resolves.toBeNull();
  });

  it("treats a readback READ ERROR (not just a mismatch) as unverified and rolls back fail-closed", async () => {
    const { nango } = makeDeps({ configured: true, savedConnection: null });
    nango.getCredentials.mockRejectedValueOnce(new Error("nango read blip"));
    await expect(saveAnthropicAPISettings({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    expect(nango.saveConnectionRecord).not.toHaveBeenCalled();
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("claude");
  });

  it("on a ROTATION (existing pointer) with a readback mismatch, deletes the mutated credential AND drops the stale pointer so it is NOT reachable", async () => {
    const { nango } = makeDeps({
      configured: true,
      // A prior verified pointer already references the deterministic location
      // whose credential the import just mutated.
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
      credentials: { apiKey: "sk-rotated-unverified" }, // readback != trimmed input
    });
    await expect(saveAnthropicAPISettings({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    expect(nango.saveConnectionRecord).not.toHaveBeenCalled();
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("claude");
    // The mutated credential + stale pointer are gone → the pointer-gated read
    // cannot reach the unverified credential (fail-closed rotation).
    await expect(getConfiguredAnthropicConnection()).resolves.toBeNull();
  });

  it("still drops the pointer when the credential DELETE fails (fail-closed across a cleanup failure)", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
      credentials: { apiKey: "sk-rotated-unverified" },
    });
    nango.deleteConnection.mockRejectedValueOnce(new Error("nango delete failed"));
    await expect(saveAnthropicAPISettings({ apiKey: "sk-new" })).rejects.toThrow(/verification failed/i);
    // deleteConnection rejected, but clearConnectionRecords was STILL attempted
    // (allSettled), so the stale pointer is dropped and the credential is
    // unreachable via the pointer-gated read.
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("claude");
    await expect(getConfiguredAnthropicConnection()).resolves.toBeNull();
  });

  it("no-ops on a blank re-submit when a saved pointer exists (leave-blank-to-keep)", async () => {
    const { nango } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
    });
    await expect(saveAnthropicAPISettings({ apiKey: "   " })).resolves.toBeDefined();
    expect(nango.importConnection).not.toHaveBeenCalled();
  });

  it("throws on a blank submit when there is no saved pointer to keep", async () => {
    makeDeps({ configured: true, savedConnection: null });
    await expect(saveAnthropicAPISettings({})).rejects.toThrow(/Enter an Anthropic API key/i);
  });
});

describe("clearAnthropicAPISettings — full disconnect (finding 2)", () => {
  it("purges local settings, the legacy DB row, and the Nango connection + records", async () => {
    const { nango, deps } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
      dbRow: { apiKey: "sk-legacy" },
    });
    await clearAnthropicAPISettings();
    expect(deps.deleteConnectorConfigFromDatabase).toHaveBeenCalledWith("anthropic_connection");
    expect(nango.deleteConnection).toHaveBeenCalledWith(PCK, CID);
    expect(nango.clearConnectionRecords).toHaveBeenCalledWith("claude");
    // After clear, nothing resolves the credential anymore.
    await expect(getConfiguredAnthropicConnection()).resolves.toBeNull();
  });

  it("purges the legacy DB row even when the Nango deletion fails", async () => {
    const { deps } = makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: PCK, connectionId: CID },
      dbRow: { apiKey: "sk-legacy" },
      deleteConnectionImpl: async () => {
        throw new Error("nango down");
      },
    });
    await expect(clearAnthropicAPISettings()).rejects.toThrow(/nango down/);
    expect(deps.deleteConnectorConfigFromDatabase).toHaveBeenCalledWith("anthropic_connection");
  });
});

describe("getAnthropicAPIStatus — consults the legacy fallback (finding 2)", () => {
  it("connected via the saved Nango pointer", () => {
    makeDeps({
      configured: true,
      savedConnection: { providerConfigKey: PCK, connectionId: CID, displayName: "acct" },
    });
    const s = getAnthropicAPIStatus();
    expect(s.status).toBe("connected");
    expect(s.detail).toContain("acct");
  });

  it("connected via the legacy DB fallback when there is no pointer (calls actually work off it)", () => {
    makeDeps({ configured: true, savedConnection: null, dbRow: { apiKey: "sk-legacy" } });
    expect(getAnthropicAPIStatus().status).toBe("connected");
  });

  it("not_connected when neither a pointer nor a legacy row exists", () => {
    makeDeps({ configured: true, savedConnection: null, dbRow: null });
    expect(getAnthropicAPIStatus().status).toBe("not_connected");
  });
});
