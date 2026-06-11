// The anthropic connector's `register(ctx)` server entry.
//
// Lazy/guarded host-access cutover: the host's settings/status
// surfaces (campaign actions, the MCP llm-access test route) resolve this
// connector's readers/writers through the `llm-provider-surface` capability
// instead of value-importing the package. Provider absence degrades each
// host feature per call.
//
// SCOPE NOTE: the static host-DI deps wiring (`registerAnthropicConnector(deps)`
// in the host's register-transport-connectors.ts) is explicitly out of this
// cutover's scope and unchanged — this entry registers ONLY the host-facing
// surface capability. Registration-only (no I/O) — safe under
// required-extension-activation's prod-boot arming, and probe-safe.
//
// SDK imports here are TYPE-ONLY (host-peer value-import ban); the imported
// package modules carry no SDK value imports.
//
// TRUST BOUNDARY: the surface is host-internal in-process wiring (the
// capability registry is server-side only). The writers exposed here carry
// the SAME authorization posture as the static imports they replace: the
// host's campaign-action call sites own the gating (the connector's own
// settings form binds its separately manage-gated action, unchanged).

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import {
  getConfiguredAnthropicConnection,
  getDefaultClaudeModel,
  saveDefaultClaudeModel,
  saveAnthropicAPISettings,
  clearAnthropicAPISettings,
  CLAUDE_MODELS,
  type ClaudeModel,
} from "./index";

const PACKAGE_NAME = "@cinatra-ai/anthropic-connector";

export function register(ctx: ExtensionHostContext): void {
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
