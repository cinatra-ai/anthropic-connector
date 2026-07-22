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
  /** Read back the stored credentials. `forceRefresh` bypasses Nango's cache so
   *  a write-then-read-back verification reads the just-written credential. */
  getCredentials(
    providerConfigKey: string,
    connectionId: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<unknown>;
  /** Ensure the provider-config (integration) row exists. */
  ensureIntegration(input: { provider: string; providerConfigKey: string; displayName?: string }): Promise<unknown>;
  /** Upsert a connection record by (providerConfigKey, connectionId). anthropic
   *  OMITS `connectorKey` so the cinatra-side pointer is NOT auto-saved before
   *  the readback verification (the pointer is saved via `saveConnectionRecord`
   *  only after the readback compare passes). */
  importConnection(input: {
    connectorKey?: string;
    providerConfigKey: string;
    connectionId: string;
    credentials: { type: string; apiKey: string };
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  /** Persist the cinatra-side pointer row AFTER a verified readback.
   *  `{ multiple: false }` enforces a single workspace-wide credential. The
   *  pointer is the "verified + committed" signal that
   *  `getConfiguredAnthropicConnection` gates its Nango read on, so it must
   *  never be written before the readback compare passes. */
  saveConnectionRecord(
    connectorKey: "claude",
    record: {
      connectionId: string;
      providerConfigKey: string;
      displayName?: string;
      metadata?: Record<string, unknown>;
    },
    opts?: { multiple?: boolean },
  ): Promise<unknown>;
  /** Delete the Nango connection (scrubs stored credentials). */
  deleteConnection(providerConfigKey: string, connectionId: string): Promise<unknown>;
  /** Clear the cinatra-side pointer rows for this connector. */
  clearConnectionRecords(connectorKey: "claude"): Promise<unknown>;
  /** Provider-config-key bag — only this connector's slug is exposed. */
  providerConfigKeys: { claude: string };
  /** Connection-id bag — only this connector's slug is exposed. */
  connectionIds: { claude: string };
}

/**
 * The Skills-setting host capability (cinatra-ai/cinatra#1104 — S3a of the
 * connector-setup-tabs epic, cinatra#1101). That migration moves the
 * `anthropic-skill-sync-enabled` read/write out of core (today it lives
 * entirely in `_default-llm-select.tsx` / `campaigns/actions.ts`) into a host
 * capability this connector calls, mirroring the existing
 * `readConnectorConfigFromDatabase`/`writeConnectorConfigToDatabase` pattern —
 * `read()` returns the persisted opt-in (default off); `write()` persists it
 * (and, on the host side, should preserve the existing "pre-sync at
 * admin-save time" trigger `campaigns/actions.ts` performs today).
 *
 * PROVISIONAL + THIS CONNECTOR'S OWN INTERNAL ADAPTER SHAPE (codex convergence,
 * round 1): #1104 is in progress on a sibling lane, so the REAL host-published
 * capability's id/method-names/signatures may differ from this shape once it
 * lands. Treat this interface as owned by THIS connector, not as a preview of
 * #1104's actual contract — when #1104 lands, adapt its real provider into
 * this exact `{read, write}` shape INSIDE `tryAnthropicSkillConfig` (the single
 * resolution site in register.ts), so deps.ts/index.ts and every test built
 * against this interface need no further changes. Optional + nullable so a
 * host that predates #1104 simply resolves `null` here; every Skills-tab
 * caller (see index.ts's `getAnthropicSkillSyncEnabled` /
 * `saveAnthropicSkillSyncEnabled` / `getAnthropicSkillSyncCapabilityReady`)
 * degrades gracefully on `null` instead of throwing.
 */
export interface HostAnthropicSkillConfigShape {
  /** The persisted opt-in (mirrors readAnthropicSkillSyncEnabledFromDatabase). */
  read(): boolean;
  /** Persist the opt-in (mirrors writeAnthropicSkillSyncEnabledToDatabase). */
  write(enabled: boolean): void | Promise<void>;
}

export interface AnthropicConnectorDeps {
  // connector_config (raw connectorId key)
  readConnectorConfigFromDatabase: <T>(connectorId: string, fallback: T) => T;
  writeConnectorConfigToDatabase: (connectorId: string, value: unknown) => void;
  // Physically delete a connector-config row (backed by the host connector-config
  // service's `delete` member). Used to purge the legacy `anthropic_connection`
  // DB-fallback credential on clear/save so a cleared connection cannot keep
  // resolving an old plaintext key. PHYSICAL remove, never a blank — a dead
  // credential must be removed.
  deleteConnectorConfigFromDatabase: (connectorId: string) => void;
  // the anthropic connection row in the metadata store (DB fallback credential)
  readAnthropicConnectionFromDatabase: () => AnthropicConnectionRow;
  // runtime mode flag
  isAppDevelopmentMode: () => boolean;
  /**
   * The single host-resolved local-CLI eligibility predicate (cinatra#1926):
   * `development-mode OR preview-installation`, backed by the host
   * `localCliEligible` helper via the `@cinatra-ai/host:runtime-mode` service.
   * The connection-mode write rejection + transport resolution consume THIS
   * (never an independent re-derivation); binds fail-closed to `false` on a host
   * that predates the service member (the mode stays hidden/API-only).
   */
  localCliEligible: () => boolean;
  /** Nango connection-storage surface (host-bound from the nango-connector extension). */
  nango: AnthropicNangoCapability;
  /**
   * PROVISIONAL (cinatra-ai/cinatra#1104 — see HostAnthropicSkillConfigShape).
   * `null` when the host predates the migration; optional so pre-existing
   * deps fixtures (tests, older host binders) compile unchanged.
   */
  anthropicSkillConfig?: HostAnthropicSkillConfigShape | null;
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
