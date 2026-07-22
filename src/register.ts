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

import type {
  ExtensionHostContext,
  NangoSystemSurface,
  LlmProviderAdapterSurface,
} from "@cinatra-ai/sdk-extensions";
import {
  getConfiguredAnthropicConnection,
  getDefaultClaudeModel,
  saveDefaultClaudeModel,
  getPersistedDefaultClaudeModel,
  saveAnthropicAPISettings,
  clearAnthropicAPISettings,
  getAnthropicAPIStatus,
  getAnthropicSkillSyncCapabilityReady,
  saveAnthropicSkillSyncEnabled,
  CLAUDE_MODELS,
  type ClaudeModel,
} from "./index";
// Logging authority (cinatra#1715 D2, core PR #1969): the connector-local
// request-log writer + its persisted-authority settings reader, exposed on the
// llm-provider-surface below so the host routes anthropic logging through this
// connector (mirroring openai/gemini).
import { getAnthropicLoggingSettings, writeAnthropicLogFile } from "./telemetry";
import { ANTHROPIC_API_LOG_DIRECTORY } from "./log-directory";

import {
  registerAnthropicConnector,
  getAnthropicDeps,
  type AnthropicConnectorDeps,
  type HostAnthropicSkillConfigShape,
} from "./deps";
// Connection-mode (API vs local CLI) selector persistence + transport resolution
// (cinatra#1926). The gated `localCli` option is stripped server-side by the host
// setup route when ineligible; these handlers add the WRITE-side rejection +
// hydration, all consuming the same host `localCliEligible` predicate.
import {
  decideConnectionModeWrite,
  getResolvedConnectionTransport,
  saveConnectionMode,
} from "./connection-mode";
// The relocated Anthropic request-translation adapter (llm-providers S4,
// cinatra#1715). The host's packages/llm resolves this connector's
// `createAdapter()` factory through the `llm-provider-adapter` capability
// instead of its in-core `providers/anthropic.ts` switch.
import { createAnthropicProviderAdapter } from "./adapter/anthropic-adapter";

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
// cinatra#1926: the runtime-mode service ALSO carries the single local-CLI
// eligibility predicate. `localCliEligible` is OPTIONAL in this structural shape
// so the binding stays fail-closed against a host that predates it (a missing
// member ⇒ the local-CLI mode stays hidden / write-rejected / API-only).
type HostRuntimeModeShape = {
  isDevelopment(): boolean;
  localCliEligible?(): boolean;
};

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

/**
 * PROVISIONAL resolver for the Skills-setting host capability
 * (cinatra-ai/cinatra#1104 — see deps.ts's HostAnthropicSkillConfigShape doc).
 * Unlike `hostService()`, this NEVER throws on absence — #1104 is in progress
 * on a sibling lane, so a host that predates it simply has no provider
 * registered under this id yet, and every Skills-tab caller (index.ts) must
 * degrade gracefully rather than crash registration or a probe/save call. The
 * capability id + shape are this connector's best-informed guess at what
 * #1104 will expose (mirroring the existing
 * readConnectorConfigFromDatabase/writeConnectorConfigToDatabase pattern);
 * this is the SINGLE site to update if the landed contract differs.
 */
function tryAnthropicSkillConfig(ctx: ExtensionHostContext): HostAnthropicSkillConfigShape | null {
  const provider = ctx.capabilities.resolveProviders("@cinatra-ai/host:anthropic-skill-config")[0];
  const impl = provider?.impl as HostAnthropicSkillConfigShape | undefined;
  if (!impl || typeof impl.read !== "function" || typeof impl.write !== "function") return null;
  return impl;
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
    // cinatra#1926: consume the host's single localCliEligible predicate. Optional
    // chaining + `=== true` fail closed (a host without the member ⇒ ineligible).
    localCliEligible: () => runtimeMode().localCliEligible?.() === true,
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
    // PROVISIONAL (cinatra-ai/cinatra#1104): a getter so EVERY access
    // freshly re-resolves via ctx (never cached null) — the same lazy-getter
    // pattern as `nango.providerConfigKeys`/`connectionIds` above, so a host
    // that activates this connector before #1104 lands and is later upgraded
    // (without a re-activation) still picks the capability up on next access.
    get anthropicSkillConfig() {
      return tryAnthropicSkillConfig(ctx);
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
      // Logging authority cutover (cinatra#1715 D2, core PR #1969): the host's
      // packages/llm resolves the anthropic request-log writer + its settings
      // reader through this surface (mirroring openai/gemini) instead of an
      // in-tree copy — core's `writeLlmLogFile` routes anthropic through
      // `writeProviderLogFile("anthropic", …)`. The writer keeps the connector's
      // STATELESS logging-enabled gate (the persisted `anthropic-logging`
      // connector-config key) + Bearer redaction; absence host-side degrades to
      // a no-op. The admin WRITE path stays host-side (`saveAnthropicLoggingSettings`
      // → the same key), so NO `saveLoggingSettings` is exposed — this connector
      // only READS the flag.
      getLoggingSettings: () => getAnthropicLoggingSettings(),
      logDirectory: ANTHROPIC_API_LOG_DIRECTORY,
      writeLogFile: (input: { label: string; kind: "request" | "response"; body: unknown }) =>
        writeAnthropicLogFile({ label: input.label, kind: input.kind, body: input.body }),
    },
  });

  // ---- llm-provider-adapter surface (llm-providers S4, cinatra#1715) ----
  //
  // The full Anthropic request-translation adapter now lives IN this connector
  // (relocated from the host's packages/llm `providers/anthropic.ts`). The host's
  // packages/llm resolves the adapter through this NEW versioned
  // `llm-provider-adapter` capability instead of its in-core factory switch:
  // once a trusted surface is registered the host calls `createAdapter()` and
  // does NOT fall back to the legacy in-core factory (the host fails CLOSED on
  // an abiVersion it does not recognise). `createAdapter()` resolves the
  // connector-owned connection internally and returns null when the connector is
  // present-but-unconfigured — an AUTHORITATIVE "not configured" (the registry's
  // existing null-adapter semantics; no new error class). Registration does no
  // host I/O (probe-safe). The capability-id is a string literal because it stays
  // host-fenced in the SDK (`./internal`), exactly like the S1 surface above.
  ctx.capabilities.registerProvider("llm-provider-adapter", {
    packageName: PACKAGE_NAME,
    impl: {
      // ABI v1 is inlined as a literal (NOT value-imported from the host-peer
      // SDK — the host-peer-value-import ban keeps @cinatra-ai/sdk-extensions
      // TYPE-only over the serverEntry graph). The `satisfies
      // LlmProviderAdapterSurface` below type-checks this literal against the
      // leaf's `typeof LLM_PROVIDER_ADAPTER_ABI_VERSION`, so an ABI bump breaks
      // the build here rather than drifting silently.
      abiVersion: 1,
      providerId: "anthropic",
      createAdapter: async () => {
        const connection = await getConfiguredAnthropicConnection();
        return connection ? createAnthropicProviderAdapter(connection) : null;
      },
    } satisfies LlmProviderAdapterSurface,
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

  // READ (manage-gated): the persisted NON-SECRET setup values, keyed by
  // declared field key — the connector's opt-in setup-form hydration read
  // (root `hydrateAction` in cinatra.configSchema). The host invokes this
  // SERVER-SIDE while rendering the setup page and threads the sanitized
  // result in as the form's `initialValues`; every failure path resolves a
  // blank form host-side, never an error page. Must stay a side-effect-free
  // idempotent read (the host calls it on every setup render). NEVER returns
  // the apiKey (write-only secret — and the host sanitizer refuses secret
  // keys regardless). Manage-gated FIRST: the setup surface is admin-only,
  // and a denied/missing guard fails closed before any store read.
  ctx.ui.registerAction({
    id: "currentConfig",
    handler: async (): Promise<Record<string, string>> => {
      await requireManage();
      const out: Record<string, string> = {};
      const model = getPersistedDefaultClaudeModel();
      // Only a persisted, still-known model hydrates; absent (or a stored
      // value no longer in CLAUDE_MODELS) leaves the form on its declared
      // default rather than pre-filling an unselectable option.
      if (model && (CLAUDE_MODELS as readonly string[]).includes(model)) {
        out.defaultModel = model;
      }
      // Connection mode (cinatra#1926): hydrate the RESOLVED transport, not the
      // raw persisted value — so an ineligible installation (where the server
      // stripped the `localCli` option) pre-fills `api`, never a now-absent
      // option. Eligible + persisted `localCli` pre-fills `localCli`.
      out.connectionMode = getResolvedConnectionTransport();
      return out;
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

  // ---- Connection tab (cinatra#1926) ----
  //
  // WRITE (manage-gated): persist the API-vs-local-CLI connection mode. This is
  // the Connection tab's OWN save (mirrors the Skills tab's saveSkills), so the
  // selector is self-contained and saveable. SERVER-SIDE enforcement via the
  // pure `decideConnectionModeWrite` policy: a forged write selecting `localCli`
  // on an ineligible installation is REJECTED (defense in depth over the option
  // being stripped from the rendered DOM), consuming the SAME host
  // `localCliEligible` predicate the setup route uses — never a client value.
  ctx.ui.registerAction({
    id: "saveConnectionMode",
    handler: async (input: unknown): Promise<{ banner: string }> => {
      await requireManage();
      const fields =
        input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const decision = decideConnectionModeWrite(fields.connectionMode, {
        localCliEligible: getAnthropicDeps().localCliEligible(),
      });
      if (!decision.ok) {
        return { banner: "error" };
      }
      if (decision.persist) {
        saveConnectionMode(decision.persist);
      }
      return { banner: "connectionSaved" };
    },
  });

  // ---- Skills tab (cinatra-ai/cinatra#44 — Epic connector-setup-tabs S3b) ----
  //
  // Moves the `anthropic-skill-sync-enabled` opt-in + its ZDR advisory out of
  // core (`_default-llm-select.tsx` / `campaigns/actions.ts`) into a dedicated
  // "Skills" tab, per cinatra-ai/cinatra#1104 (S3a — a sibling lane migrating
  // the setting's read/write into the `anthropicSkillConfig` host capability;
  // see deps.ts + tryAnthropicSkillConfig above). #1104 has not landed as of
  // this writing, so `skillsCapabilityReady` + `saveSkills` below degrade
  // GRACEFULLY (never throw) when the capability is absent — the tab still
  // renders; only its persistence round-trip is gated on the capability.

  // READ/PROBE: whether the host exposes the Skills capability yet — drives
  // the Skills tab's data-residency advisory (ready → the ZDR warning;
  // not-ready → "not available on this host version yet").
  ctx.ui.registerAction({
    id: "skillsCapabilityReady",
    handler: async (): Promise<{ ready: boolean }> => ({
      ready: getAnthropicSkillSyncCapabilityReady(),
    }),
  });

  // WRITE (manage-gated): persist the skill-upload opt-in. Fail-graceful — an
  // absent host capability returns the "skillsUnavailable" banner instead of
  // throwing (the manage gate itself still fails CLOSED, same as every other
  // write action here).
  ctx.ui.registerAction({
    id: "saveSkills",
    handler: async (input: unknown): Promise<{ banner: string }> => {
      await requireManage();
      const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const submitted = fields.skillSyncEnabled === "true";
      const result = await saveAnthropicSkillSyncEnabled(submitted);
      return { banner: result.ok ? "skillsSaved" : "skillsUnavailable" };
    },
  });

  // ---- Help tab ----
  //
  // Read-only setup how-to (design spec app-connectors §II: "no form, no
  // Save"). The schema-config vocabulary has no plain static-text field kind,
  // so the Help tab's prose rides the `advisory` field kind via this trivial,
  // always-ready, zero-I/O probe — both Help fields share it.
  ctx.ui.registerAction({
    id: "helpContentReady",
    handler: async (): Promise<{ ready: boolean }> => ({ ready: true }),
  });
}
