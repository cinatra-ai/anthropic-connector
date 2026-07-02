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
  getPersistedDefaultClaudeModel,
  saveAnthropicAPISettings,
  clearAnthropicAPISettings,
  getAnthropicAPIStatus,
  CLAUDE_MODELS,
  type ClaudeModel,
} from "./index";

import {
  registerAnthropicConnector,
  getAnthropicDeps,
  type AnthropicConnectorDeps,
} from "./deps";

const PACKAGE_NAME = "@cinatra-ai/anthropic-connector";

// The schema-declared default for the `defaultModel` select (mirror
// package.json cinatra.configSchema[defaultModel].defaultValue —
// config-schema.test.ts pins them equal). Because the host does not yet thread
// `initialValues` into schema-config forms, an un-prepopulated form renders +
// submits this declared default. Treating that as an explicit choice would
// CLOBBER an admin's chosen model on any unrelated api-key re-save, so a
// submitted value equal to the declared default is kept-persisted when the
// stored model differs (mirrors openai-connector's DECLARED_DEFAULTS no-loss
// handling). Exported so the config-schema test can pin it equal to the
// manifest's declared defaultValue.
export const DECLARED_DEFAULT_MODEL = "claude-sonnet-4-6";

// Local STRUCTURAL shapes of the per-concern host services this connector
// adapts into its deps slot (ids inlined; the graph stays SDK-type-only; the
// host-side contract types live in @cinatra-ai/sdk-extensions — these stay
// local so the connector compiles against ANY host SDK it meets during skew).
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
  // PHYSICAL row delete — the host connector-config service publishes this
  // (used to purge the legacy `anthropic_connection` DB-fallback credential).
  delete(connectorId: string): void;
};
type HostAnthropicConnectionShape = {
  readRowFromDatabase: AnthropicConnectorDeps["readAnthropicConnectionFromDatabase"];
};
type HostRuntimeModeShape = { isDevelopment(): boolean };

/** The host-published action-guard service (value, NOT the SDK
 *  `requireExtensionAction` import — a runtime serverEntry graph rejects SDK
 *  value imports). `require(packageId, mode)` resolves the actor from the
 *  request session and enforces the per-install extension access policy,
 *  failing closed (throw/redirect) on denial. Mirrors openai-connector. */
type HostActionGuard = {
  require: (packageId: string, mode: "read" | "manage") => Promise<void>;
};

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
    deleteConnectorConfigFromDatabase: (connectorId) => config().delete(connectorId),
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
      getCredentials: (providerConfigKey, connectionId, opts) =>
        nango().getNangoCredentials(providerConfigKey, connectionId, opts),
      saveConnectionRecord: (connectorKey, record, opts) =>
        nango().saveNangoConnectionRecord(connectorKey, record, opts),
      ensureIntegration: (input) =>
        nango().ensureNangoIntegration(input as Parameters<NangoSystemSurface["ensureNangoIntegration"]>[0]),
      importConnection: (input) =>
        nango().importNangoConnection(input as Parameters<NangoSystemSurface["importNangoConnection"]>[0]),
      deleteConnection: (providerConfigKey, connectionId) =>
        nango().deleteNangoConnection(providerConfigKey, connectionId),
      clearConnectionRecords: (connectorKey) => nango().clearNangoConnectionRecords(connectorKey),
      // Vendor identity is OPEN at the SDK (#12): the surface's key maps are
      // `Record<string, string>` (no SDK-frozen union), so this connector
      // projects ITS OWN key out of the open map at the boundary rather than
      // asserting the whole map's shape.
      get providerConfigKeys() {
        return { claude: nango().providerConfigKeys.claude };
      },
      get connectionIds() {
        return { claude: nango().connectionIds.claude };
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

  // ---- schema-config named actions (cinatra#782) ----
  //
  // The declarative setup surface (cinatra.configSchema) renders WITHOUT
  // shipping React. Its probe + named-action fields reference these
  // host-registered actions BY ID; the host dispatches them through the single
  // endpoint `/api/extensions/{installId}/actions/{actionId}`, which resolves +
  // authorizes the actor at the "use" tier BEFORE calling the handler. Because
  // saving/clearing a credential is a MANAGE-tier mutation (the prior
  // saveAnthropicSettingsAction gated "manage"), the WRITE handlers re-assert
  // the manage gate via the host action-guard service — the "use"-tier endpoint
  // check alone would be a regression. Requires the "ui" host port (declared in
  // cinatra.requestedHostPorts).

  // Resolve the host's action-guard service LAZILY at action-call time (the same
  // value the SDK `requireExtensionAction` slot binds), so activation order
  // never matters and a missing guard FAILS CLOSED. Imported as a VALUE through
  // the capability registry — NEVER as an SDK value import (a runtime
  // serverEntry graph rejects those). Mirrors openai-connector.
  const requireManage = async (): Promise<void> => {
    const provider = ctx.capabilities.resolveProviders(
      "@cinatra-ai/host:extension-action-guard",
    )[0];
    const guard = provider?.impl as HostActionGuard | undefined;
    if (!guard || typeof guard.require !== "function") {
      throw new Error(
        `${PACKAGE_NAME}: host action-guard service is not registered — refusing the ungated action.`,
      );
    }
    await guard.require(PACKAGE_NAME, "manage");
  };

  // READ/PROBE: whether the connection (Nango) service is configured for API-key
  // storage — drives the `advisory` field's copy. Boolean data only.
  ctx.ui.registerAction({
    id: "connectionServiceReady",
    handler: async (): Promise<{ ready: boolean }> => ({
      ready: getAnthropicDeps().nango.isConfigured(),
    }),
  });

  // PROBE: connection status. THROWS when not connected so the status-probe pill
  // renders "error" (any 2xx renders OK); a connected status returns its detail.
  ctx.ui.registerAction({
    id: "connectionStatus",
    handler: async (): Promise<{ detail: string }> => {
      const status = getAnthropicAPIStatus();
      if (status.status !== "connected") {
        throw new Error(status.detail);
      }
      return { detail: status.detail };
    },
  });

  // WRITE (manage-gated): persist the API key (synced to Nango) + the default
  // Claude model. The schema-config form posts the flat text/secret/select
  // inputs as JSON. A blank apiKey is treated as ABSENT (no overwrite) — the
  // form sends an empty secret input when untouched, and saveAnthropicAPISettings
  // falls back to the currently-stored key. An unknown model value is ignored
  // (mirrors the prior action's CLAUDE_MODELS.includes guard).
  ctx.ui.registerAction({
    id: "saveConnection",
    handler: async (input: unknown): Promise<{ banner: string }> => {
      await requireManage();
      const fields =
        input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const rawApiKey = typeof fields.apiKey === "string" ? fields.apiKey.trim() : "";
      const rawModel = typeof fields.defaultModel === "string" ? fields.defaultModel : "";
      if (rawApiKey) {
        await saveAnthropicAPISettings({ apiKey: rawApiKey });
      }
      if ((CLAUDE_MODELS as readonly string[]).includes(rawModel)) {
        // Keep-persisted no-loss: skip the write when the submission is
        // indistinguishable from an un-prepopulated form re-submitting the
        // declared default over a DIFFERENT stored choice. A value that differs
        // from the declared default (or a first-time save with no stored model)
        // is the admin's explicit intent → apply it.
        const persistedModel = getPersistedDefaultClaudeModel();
        const isUnprepopulatedDefault =
          rawModel === DECLARED_DEFAULT_MODEL &&
          persistedModel !== undefined &&
          persistedModel !== rawModel;
        if (!isUnprepopulatedDefault) {
          saveDefaultClaudeModel(rawModel as ClaudeModel);
        }
      }
      return { banner: "saved" };
    },
  });

  // WRITE (manage-gated): clear the stored connection (scrubs the Nango
  // credential + cinatra-side pointer rows).
  ctx.ui.registerAction({
    id: "clearConnection",
    handler: async (): Promise<{ banner: string }> => {
      await requireManage();
      await clearAnthropicAPISettings();
      return { banner: "cleared" };
    },
  });
}
