// Host dependency injection for the anthropic connector (decoupled to SDK-only
// like every other connector).
//
// Decouples the connector from host-internal modules: `@/lib/database`
// (connector-config + the anthropic connection row), `@/lib/runtime-mode`, and the
// Nango connection-storage surface (`@/lib/nango`, formerly reached via
// `@cinatra-ai/nango-connector`). The host binds concrete impls at boot via
// `registerAnthropicConnector(deps)`; runtime functions resolve them via
// `getAnthropicDeps()`.
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol so
// the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles (the /connectors + /configuration pages,
// server actions, the LLM provider) that do NOT import the registrar — resolve the
// SAME slot. (Same reason as the SDK action-guard + apify/gemini/openai/tailscale
// deps + the email-connector registry.)

export type AnthropicConnectionRow = { apiKey?: string } | null;

/**
 * Structural shape of the Nango connection-storage surface the anthropic connector
 * uses. Inlined (NOT imported from `@cinatra-ai/nango-connector`) so the connector
 * carries no non-SDK `@cinatra-ai/*` code dependency — the host binds the concrete
 * impls at boot. Keys are literal-scoped to this connector's slug ("claude") so an
 * invalid key can't compile here. Returns stay permissive (`unknown`); the connector
 * reads credentials defensively at the call site.
 */
export interface AnthropicNangoCapability {
  /** True when the workspace has Nango configured (credentials present). */
  isConfigured(): boolean;
  /** Connection status for the settings page. */
  getStatus(): { status: "connected" | "not_connected"; detail: string };
  /** The Nango frontend config the connect-card needs. */
  getFrontendConfig(): { apiURL?: string; baseURL?: string };
  /** The primary saved cinatra-side connection pointer for this connector, or null. */
  getPrimarySavedConnection(
    connectorKey: "claude",
  ): { providerConfigKey: string; connectionId: string; displayName?: string } | null;
  /** Read back the stored credentials. */
  getCredentials(providerConfigKey: string, connectionId: string): Promise<unknown>;
  /** Ensure the provider-config (integration) row exists. */
  ensureIntegration(input: { provider: string; providerConfigKey: string; displayName?: string }): Promise<unknown>;
  /** Upsert a connection record by (providerConfigKey, connectionId). */
  importConnection(input: {
    connectorKey?: string;
    providerConfigKey: string;
    connectionId: string;
    credentials: { type: string; apiKey: string };
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  /** Delete the Nango connection (scrubs stored credentials). */
  deleteConnection(providerConfigKey: string, connectionId: string): Promise<unknown>;
  /** Clear the cinatra-side pointer rows for this connector. */
  clearConnectionRecords(connectorKey: "claude"): Promise<unknown>;
  /** Provider-config-key bag — only this connector's slug is exposed. */
  providerConfigKeys: { claude: string };
  /** Connection-id bag — only this connector's slug is exposed. */
  connectionIds: { claude: string };
}

export interface AnthropicConnectorDeps {
  // connector_config (raw connectorId key)
  readConnectorConfigFromDatabase: <T>(connectorId: string, fallback: T) => T;
  writeConnectorConfigToDatabase: (connectorId: string, value: unknown) => void;
  // the anthropic connection row in the metadata store (DB fallback credential)
  readAnthropicConnectionFromDatabase: () => AnthropicConnectionRow;
  // runtime mode flag
  isAppDevelopmentMode: () => boolean;
  /** Nango connection-storage surface (host-bound from the nango-connector extension). */
  nango: AnthropicNangoCapability;
}

const ANTHROPIC_DEPS_KEY = Symbol.for("@cinatra-ai/anthropic-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: AnthropicConnectorDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

/**
 * Wire the runtime deps. Bound by the connector's own `register(ctx)` at
 * activation (transport-DI inversion, cinatra#151 Stage 3) — and, on hosts
 * that predate the cutover, statically at boot by the host's transport
 * binder. Re-calling replaces — tests swap stubs.
 */
export function registerAnthropicConnector(deps: AnthropicConnectorDeps): void {
  _holder[ANTHROPIC_DEPS_KEY] = deps;
}

/** True when the host runtime deps are already bound. Read by the
 * `register(ctx)` bind-if-absent skew guard (src/register.ts): on a host that
 * still binds deps statically at boot (pre transport-DI cutover) the host's
 * eager binding wins; on a cutover host nothing else binds, so register(ctx)
 * binds the lazy capability-resolving deps. Swept once every host the
 * connector can meet is post-cutover. */
export function hasAnthropicDeps(): boolean {
  return _holder[ANTHROPIC_DEPS_KEY] != null;
}

export function getAnthropicDeps(): AnthropicConnectorDeps {
  const deps = _holder[ANTHROPIC_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/anthropic-connector: host runtime deps not registered. " +
        "Call registerAnthropicConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetAnthropicDepsForTests(): void {
  _holder[ANTHROPIC_DEPS_KEY] = null;
}
