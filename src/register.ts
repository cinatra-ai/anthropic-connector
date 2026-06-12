// The anthropic connector's `register(ctx)` server entry.
//
// Lazy/guarded host-access cutover: the host's settings/status
// surfaces (campaign actions, the MCP llm-access test route) resolve this
// connector's readers/writers through the `llm-provider-surface` capability
// instead of value-importing the package. Provider absence degrades each
// host feature per call.
//
// Transport-DI inversion (cinatra#151 Stage 3): this entry ALSO binds the
// connector's host deps slot (`registerAnthropicConnector(deps)`) by adapting
// the per-concern host services published in the capability registry —
// authorship of the transport registration moved connector-side; the host
// names this package nowhere. Every deps member resolves its host service
// LAZILY at call time. Registration-only (no I/O) — safe under
// required-extension-activation's prod-boot arming, and probe-safe (the
// probe's `resolveProviders` reads stay live, so a probe-bound deps slot
// resolves identically to an activation-bound one).
//
// SDK imports here are TYPE-ONLY (host-peer value-import ban); the imported
// package modules carry no SDK value imports.
//
// TRUST BOUNDARY: the surface is host-internal in-process wiring (the
// capability registry is server-side only). The writers exposed here carry
// the SAME authorization posture as the static imports they replace: the
// host's campaign-action call sites own the gating (the connector's own
// settings form binds its separately manage-gated action, unchanged).

import type { ExtensionHostContext, NangoSystemSurface } from "@cinatra-ai/sdk-extensions";
import {
  getConfiguredAnthropicConnection,
  getDefaultClaudeModel,
  saveDefaultClaudeModel,
  saveAnthropicAPISettings,
  clearAnthropicAPISettings,
  CLAUDE_MODELS,
  type ClaudeModel,
} from "./index";

import { registerAnthropicConnector, type AnthropicConnectorDeps } from "./deps";

const PACKAGE_NAME = "@cinatra-ai/anthropic-connector";

// Local STRUCTURAL shapes of the per-concern host services this connector
// adapts into its deps slot (ids inlined; the graph stays SDK-type-only; the
// host-side contract types live in @cinatra-ai/sdk-extensions — these stay
// local so the connector compiles against ANY host SDK it meets during skew).
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
};
type HostAnthropicConnectionShape = {
  readRowFromDatabase: AnthropicConnectorDeps["readAnthropicConnectionFromDatabase"];
};
type HostRuntimeModeShape = { isDevelopment(): boolean };

/** Lazy per-concern host-service resolution (fail-loud on a missing service). */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring (register-host-connector-services) must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

/** The connector-authored nango-system surface (registered by the nango
 * gateway's own register(ctx) — a systemExtension, required at boot). */
function nangoSystem(ctx: ExtensionHostContext): NangoSystemSurface {
  const provider = ctx.capabilities.resolveProviders("nango-system")[0];
  const surface = provider?.impl as NangoSystemSurface | undefined;
  if (!surface || typeof surface.isNangoConfigured !== "function") {
    throw new Error(
      `${PACKAGE_NAME}: the "nango-system" capability surface is not registered — ` +
        `resolve at call time (post-activation), never at module eval.`,
    );
  }
  return surface;
}

/** Build the host-bound deps from the per-concern host services. Every member
 * resolves LAZILY at call time — constructing this object does no I/O and no
 * resolution (probe-safe). */
function buildHostBoundDeps(ctx: ExtensionHostContext): AnthropicConnectorDeps {
  const config = () => hostService<HostConnectorConfigShape>(ctx, "@cinatra-ai/host:connector-config");
  const connection = () =>
    hostService<HostAnthropicConnectionShape>(ctx, "@cinatra-ai/host:anthropic-connection");
  const runtimeMode = () => hostService<HostRuntimeModeShape>(ctx, "@cinatra-ai/host:runtime-mode");
  const nango = () => nangoSystem(ctx);
  return {
    readConnectorConfigFromDatabase: <T,>(connectorId: string, fallback: T): T =>
      config().read(connectorId, fallback),
    writeConnectorConfigToDatabase: (connectorId, value) => config().write(connectorId, value),
    readAnthropicConnectionFromDatabase: () => connection().readRowFromDatabase(),
    isAppDevelopmentMode: () => runtimeMode().isDevelopment(),
    // Nango connection-storage members delegate to the connector-authored
    // nango-system surface at CALL time (key maps are getters for the same
    // reason). Inputs are cast at this boundary: the surface owns the real
    // NangoConnectorKey union / required-displayName shape and this connector
    // only ever passes valid values (same note as the host-era binding).
    nango: {
      isConfigured: () => nango().isNangoConfigured(),
      getStatus: () => nango().getNangoStatus(),
      getFrontendConfig: () => nango().getNangoFrontendConfig(),
      getPrimarySavedConnection: (connectorKey) => nango().getPrimarySavedNangoConnection(connectorKey),
      getCredentials: (providerConfigKey, connectionId) =>
        nango().getNangoCredentials(providerConfigKey, connectionId),
      ensureIntegration: (input) =>
        nango().ensureNangoIntegration(input as Parameters<NangoSystemSurface["ensureNangoIntegration"]>[0]),
      importConnection: (input) =>
        nango().importNangoConnection(input as Parameters<NangoSystemSurface["importNangoConnection"]>[0]),
      deleteConnection: (providerConfigKey, connectionId) =>
        nango().deleteNangoConnection(providerConfigKey, connectionId),
      clearConnectionRecords: (connectorKey) => nango().clearNangoConnectionRecords(connectorKey),
      get providerConfigKeys() {
        return nango().providerConfigKeys;
      },
      get connectionIds() {
        return nango().connectionIds;
      },
    },
  };
}

export function register(ctx: ExtensionHostContext): void {
  // Transport-DI inversion: bind the host deps slot. Always-bind (the
  // bind-if-absent skew guard was swept once every host this connector can
  // meet is post-cutover): re-activation — incl. a hot-update digest swap —
  // re-binds fresh lazy resolvers, so a stale deps object can never outlive
  // its digest.
  registerAnthropicConnector(buildHostBoundDeps(ctx));

  ctx.capabilities.registerProvider("llm-provider-surface", {
    packageName: PACKAGE_NAME,
    impl: {
      providerId: "anthropic",
      getConfiguredConnection: () => getConfiguredAnthropicConnection(),
      getDefaultModel: () => getDefaultClaudeModel(),
      // The host validates against `models` before calling (its previous
      // CLAUDE_MODELS.includes(...) check); the cast is the same narrowing the
      // old static import performed.
      saveDefaultModel: (model: string) => saveDefaultClaudeModel(model as ClaudeModel),
      saveAPISettings: (input: { apiKey: string }) => saveAnthropicAPISettings(input),
      clearAPISettings: () => clearAnthropicAPISettings(),
      models: CLAUDE_MODELS,
    },
  });
}
