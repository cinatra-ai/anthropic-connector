import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions";
import { getAnthropicDeps } from "./deps";

// The legacy connector-config row that older installs used as a plaintext
// credential fallback (read via `readAnthropicConnectionFromDatabase`). Modern
// saves vault the key in Nango and never write this row, but a stale value can
// still shadow a "cleared" connection — so clear/save purge it physically.
const ANTHROPIC_LEGACY_CONNECTION_ROW = "anthropic_connection";

// Shared extractor that accepts both the `{ apiKey: string }` object shape and
// the raw-string fallback shape that `getCredentials` can return, so the
// readback compare and the credential read are consistent across call sites.
function extractApiKey(credentials: unknown): string | null {
  if (credentials && typeof credentials === "object" && "apiKey" in credentials) {
    const candidate = (credentials as { apiKey: unknown }).apiKey;
    return typeof candidate === "string" ? candidate : null;
  }
  if (typeof credentials === "string") return credentials;
  return null;
}

// Re-export the host-deps registrar from the package index so the host binder
// imports it from `@cinatra-ai/anthropic-connector` (the index), not the `/deps`
// subpath — matching the gemini/apify deps-pattern connectors. (openai uses the
// `/deps` subpath only to avoid its index → skills → agents boot cycle; this index
// has no such cycle — `./deps` is a leaf — so the index import is safe + resolves in
// every context, including the packages/agents vitest where the bare `/deps` subpath
// of a `"type":"module"` package does not.)
export { registerAnthropicConnector } from "./deps";
export type { AnthropicConnectorDeps } from "./deps";

// `claude-opus-4-7` is an allowed configurable model.
// It is NOT a new default — `getDefaultClaudeModel()` still returns haiku (dev) /
// sonnet (prod).
//
// NOTE on the two Anthropic model lists: this connector UI list and
// `ALLOWED_MODEL_IDS.anthropic` in `packages/agents/src/llm-provider-policy.ts`
// are DISTINCT layers (connector model picker vs OAS-validator allow-list). The
// lists intentionally do not have to be identical, but any model selectable here
// must also be accepted by the policy validator when it is used in agent OAS.
// `claude-opus-4-7` is present in BOTH lists, so an admin selecting it here is
// also accepted by the policy validator.
export const CLAUDE_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export type AnthropicAPISettings = {
  apiKey?: string;
  lastSavedAt?: string;
  defaultModel?: ClaudeModel;
  mcpMode?: "native" | "function-tools";
  promptCachingEnabled?: boolean;
};

export const anthropicAPIConnectionPackage: HostRequiredPackageDefinition = {
  packageId: "@cinatra-ai/anthropic-connector",
  name: "Anthropic API Connection",
  slug: "connector-anthropic",
  description: "API connection for Claude-powered LLM workflows.",
  // The connector setup route is the canonical settings route and unified
  // dispatch path.
  settingsHref: "/connectors/cinatra-ai/anthropic-connector/setup",
};

function readSettings() {
  return getAnthropicDeps().readConnectorConfigFromDatabase<AnthropicAPISettings>("anthropic", {});
}

function writeSettings(value: AnthropicAPISettings) {
  getAnthropicDeps().writeConnectorConfigToDatabase("anthropic", value);
}

export function getAnthropicAPISettings() {
  const settings = readSettings();

  return {
    apiKey: settings.apiKey,
    lastSavedAt: settings.lastSavedAt,
  } satisfies AnthropicAPISettings;
}

export function getDefaultClaudeModel(): ClaudeModel {
  const settings = readSettings();
  const devDefault: ClaudeModel = "claude-haiku-4-5-20251001";
  const prodDefault: ClaudeModel = "claude-sonnet-4-6";
  return settings.defaultModel ?? (getAnthropicDeps().isAppDevelopmentMode() ? devDefault : prodDefault);
}

export function saveDefaultClaudeModel(model: ClaudeModel) {
  const current = readSettings();
  writeSettings({ ...current, defaultModel: model });
}

/**
 * The RAW persisted default model (unresolved — `undefined` when the admin has
 * never chosen one), distinct from `getDefaultClaudeModel()` which resolves the
 * dev/prod fallback. The schema-config save action reads this to decide whether
 * an incoming DECLARED-DEFAULT model value is an explicit choice or an
 * un-prepopulated form re-submitting the declared default (keep persisted, no
 * clobber).
 */
export function getPersistedDefaultClaudeModel(): ClaudeModel | undefined {
  return readSettings().defaultModel;
}

export function getMcpMode(): "native" | "function-tools" {
  const settings = readSettings();
  return settings.mcpMode ?? "function-tools";
}

export function saveMcpMode(mode: "native" | "function-tools") {
  const current = readSettings();
  writeSettings({ ...current, mcpMode: mode });
}

export function getAnthropicPromptCachingEnabled(): boolean {
  const settings = readSettings();
  return settings.promptCachingEnabled ?? getAnthropicDeps().isAppDevelopmentMode();
}

export function saveAnthropicPromptCachingEnabled(enabled: boolean) {
  const current = readSettings();
  writeSettings({ ...current, promptCachingEnabled: enabled });
}

export async function getConfiguredAnthropicConnection(): Promise<{
  apiKey: string;
  defaultModel?: string;
  mcpMode?: "native" | "function-tools";
  promptCachingEnabled: boolean;
} | null> {
  const deps = getAnthropicDeps();
  const settings = readSettings();
  const storedMcpMode = settings.mcpMode;
  const storedDefaultModel = settings.defaultModel;
  const cachingEnabled = settings.promptCachingEnabled ?? deps.isAppDevelopmentMode();

  if (deps.nango.isConfigured()) {
    // Require a saved local Nango pointer BEFORE reading the credential. Without
    // this gate, a save that imported the credential but failed readback
    // verification (and therefore correctly skipped `saveConnectionRecord`)
    // would still leak an unverified credential via the deterministic
    // providerConfigKey/connectionId fallback. The pointer is the
    // "verified + committed" signal.
    const savedConnection = deps.nango.getPrimarySavedConnection("claude");
    if (savedConnection) {
      const credentials = await deps.nango.getCredentials(
        savedConnection.providerConfigKey,
        savedConnection.connectionId,
      );
      const apiKey = extractApiKey(credentials);
      if (apiKey) {
        return {
          apiKey,
          ...(storedDefaultModel ? { defaultModel: storedDefaultModel } : {}),
          ...(storedMcpMode ? { mcpMode: storedMcpMode } : {}),
          promptCachingEnabled: cachingEnabled,
        };
      }
    }
  }

  // Fall back to database-stored connection
  const dbConnection = deps.readAnthropicConnectionFromDatabase();
  if (dbConnection?.apiKey) {
    return {
      apiKey: dbConnection.apiKey,
      ...(storedDefaultModel ? { defaultModel: storedDefaultModel } : {}),
      ...(storedMcpMode ? { mcpMode: storedMcpMode } : {}),
      promptCachingEnabled: cachingEnabled,
    };
  }

  return null;
}

export function isAnthropicConnectionReady(connection: { apiKey?: string } | null | undefined): boolean {
  return Boolean(connection?.apiKey);
}

export function getAnthropicAPIStatus() {
  const deps = getAnthropicDeps();
  const settings = getAnthropicAPISettings();
  const savedConnection = deps.nango.getPrimarySavedConnection("claude");

  if (savedConnection) {
    return {
      status: "connected" as const,
      detail: savedConnection.displayName
        ? `Connected as ${savedConnection.displayName}.`
        : "Anthropic is configured.",
    };
  }

  // Legacy DB-fallback credential: `getConfiguredAnthropicConnection` resolves
  // it after the Nango pointer, so Claude calls actually work off this row.
  // Report connected (checked before the local-unsynced "incomplete" branch)
  // so status matches real behaviour.
  if (deps.readAnthropicConnectionFromDatabase()?.apiKey) {
    return {
      status: "connected" as const,
      detail: "Anthropic is configured.",
    };
  }

  if (settings.apiKey) {
    return {
      status: "incomplete" as const,
      detail: "Save the Anthropic API key to enable Claude-powered workflows.",
    };
  }

  return {
    status: "not_connected" as const,
    detail: "Add an Anthropic API key to enable Claude-powered workflows.",
  };
}

export async function saveAnthropicAPISettings(input: {
  apiKey?: string;
}) {
  const deps = getAnthropicDeps();
  const trimmedInput = input.apiKey?.trim() ?? "";

  // "Leave blank to keep the currently saved key": a vaulted credential is
  // never reloaded into local settings, so a blank re-submit must no-op cleanly
  // when a saved Nango pointer exists rather than throw. With no saved pointer
  // and no typed key, there is nothing to keep — require one.
  if (!trimmedInput) {
    if (deps.nango.getPrimarySavedConnection("claude")) {
      return getAnthropicAPISettings();
    }
    throw new Error("Enter an Anthropic API key to continue.");
  }

  if (!deps.nango.isConfigured()) {
    throw new Error("Configure the connection service first so Anthropic API requests can authenticate.");
  }

  const providerConfigKey = deps.nango.providerConfigKeys.claude;
  const connectionId = deps.nango.connectionIds.claude;

  await deps.nango.ensureIntegration({
    provider: "anthropic",
    providerConfigKey,
    displayName: "Cinatra Anthropic",
  });

  // Readback-safe order (mirrors gemini/apify):
  //   1. import WITHOUT `connectorKey` so the cinatra-side pointer is NOT
  //      auto-written before verification.
  //   2. forceRefresh readback + extract + compare against the trimmed input.
  //      Any failure here — a value MISMATCH or a read ERROR — is treated as
  //      unverified.
  //   3. On failure, ROLL BACK fail-closed: the import already MUTATED the
  //      credential at the deterministic (providerConfigKey, connectionId), so a
  //      pre-existing saved pointer (a key rotation) would otherwise keep that
  //      unverified credential reachable through the pointer-gated read. Attempt
  //      BOTH cleanups regardless of each other's outcome (allSettled) —
  //      deleting the connection OR dropping the pointer each makes the
  //      credential unreachable, so one rejecting must not skip the other — then
  //      ALWAYS throw a generic error (no token in the message); never proceed.
  //   4. ONLY on a verified match save the pointer with `{ multiple: false }`.
  await deps.nango.importConnection({
    providerConfigKey,
    connectionId,
    credentials: { type: "API_KEY", apiKey: trimmedInput },
  });

  let readbackKey: string | null = null;
  try {
    const readback = await deps.nango.getCredentials(providerConfigKey, connectionId, {
      forceRefresh: true,
    });
    readbackKey = extractApiKey(readback);
  } catch {
    readbackKey = null;
  }

  if (readbackKey !== trimmedInput) {
    await Promise.allSettled([
      deps.nango.deleteConnection(providerConfigKey, connectionId),
      deps.nango.clearConnectionRecords("claude"),
    ]);
    throw new Error(
      "Nango credential verification failed: the readback value did not match the saved credential.",
    );
  }

  await deps.nango.saveConnectionRecord(
    "claude",
    { connectionId, providerConfigKey, metadata: {} },
    { multiple: false },
  );

  // The verified Nango pointer is now authoritative. Physically purge the
  // legacy `anthropic_connection` DB-fallback row so a stale plaintext key can
  // never shadow the vaulted credential on later reads.
  deps.deleteConnectorConfigFromDatabase(ANTHROPIC_LEGACY_CONNECTION_ROW);

  // Clear the local apiKey after the verified sync. Merge the FULL stored
  // settings (defaultModel / mcpMode / promptCachingEnabled) instead of a bare
  // `{apiKey, lastSavedAt}` so saving an API key cannot erase the configured
  // Claude model, MCP mode, or prompt-caching preferences.
  const persisted = readSettings();
  const nextSettings: AnthropicAPISettings = {
    ...persisted,
    apiKey: undefined,
    lastSavedAt: new Date().toISOString(),
  };
  writeSettings(nextSettings);
  return nextSettings;
}

export async function clearAnthropicAPISettings() {
  const deps = getAnthropicDeps();
  const savedConnection = deps.nango.getPrimarySavedConnection("claude");

  // Purge the local + legacy DB credential FIRST, synchronously, so a later
  // Nango deletion error cannot skip the physical legacy-row purge and leave a
  // stale plaintext key still resolving after "clear".
  writeSettings({});
  deps.deleteConnectorConfigFromDatabase(ANTHROPIC_LEGACY_CONNECTION_ROW);

  await deps.nango.deleteConnection(
    savedConnection?.providerConfigKey ?? deps.nango.providerConfigKeys.claude,
    savedConnection?.connectionId ?? deps.nango.connectionIds.claude,
  );
  await deps.nango.clearConnectionRecords("claude");
}
