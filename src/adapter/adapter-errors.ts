// Inlined orchestration-layer error classes for the relocated Anthropic
// provider adapter (llm-providers S4 — cinatra#1715). The relocated adapter +
// its `anthropic-skill-tools` leaf throw these; core's `packages/llm/src/errors.ts`
// keeps its in-tree copies until the final core-deletion PR. The ABI leaf
// supplies the TYPES (`LlmProvider`); this module supplies the connector-side
// VALUES — value-importing them from `@cinatra-ai/sdk-extensions` over the
// serverEntry graph is banned, exactly like the `adapter-floor` value slices.
//
// DIVERGENCE FLAGGED TO THE COORDINATOR (error-CONSTRUCTOR-identity duplication).
// Each class below is defined in core `packages/llm/src/errors.ts`; inlining
// connector-side gives the relocated adapter its own DISTINCT constructor
// identity, so any consumer that keys on core's identity (rather than the
// structural `.code` / `.provider` fields, which stay equal) will not recognise
// an error thrown by the resolved connector adapter. Tiers (verified against
// origin/main):
//   * LIVE regression on activation: `AnthropicSkillDeliveryError` (a root export
//     of `@cinatra-ai/llm`; base of `AnthropicFunctionToolSkillError` +
//     `AnthropicSkillCapError`) has a real cross-package `instanceof` catch — core
//     `packages/agents/src/agent-creation-review.ts` (lines 602 & 890, imported
//     from `@cinatra-ai/llm`) rethrows skill-delivery sentinels by
//     `err instanceof AnthropicSkillDeliveryError`. Once the host resolves THIS
//     connector's adapter, that check no longer matches → the sentinel is
//     swallowed to a warning instead of a deterministic blocker.
//   * LATENT, duplicated ROOT export: `BatchNotSupportedError` (thrown by the
//     adapter's batch stubs) is exported from `@cinatra-ai/llm` but has NO in-core
//     `instanceof` catch today — no present regression, but a future/external
//     `instanceof` would break.
//   * LATENT, core-INTERNAL only: `NativeMcpCapabilityRequiredError` and
//     `McpApprovalUnsupportedError` are NOT root-exported from `@cinatra-ai/llm`
//     (defined in core, not public). Their identity is duplicated but reachable
//     only by a future core catch or a later export.
// No connector-only inlining can preserve another module's constructor identity.
// Reconciling is a CORE-paired change (switch the catch sites to a structural
// `.code`/`.provider` check, or hoist the shared error contract into the ABI
// leaf so both sides reference one identity) and MUST land before this connector
// revision is INSTALLED. NOTE: the fallback is install-gated, not code-gated —
// core's resolver PREFERS a registered `llm-provider-adapter` surface, so a host
// that loads this revision WOULD resolve this adapter and skip the in-tree copy.
// This stage-1 artifact is unactivated only because the branch stays LOCAL /
// uninstalled (core's in-tree copy still serves every running host). See the lane
// divergence report (feeds stage 2).

import type { LlmProvider } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

/**
 * Thrown by the four orchestrate-* batch dispatchers when the requested
 * provider does not support the OpenAI Batch API surface (today: anthropic
 * and gemini). Throwing — rather than returning null — is intentional: it
 * forces callers to handle the gap explicitly so a future swap to a
 * supporting provider is observable.
 */
export class BatchNotSupportedError extends Error {
  readonly code = "batch_not_supported" as const;
  readonly provider: LlmProvider;

  constructor(provider: LlmProvider) {
    super(`Batch API is not supported by provider "${provider}"`);
    this.name = "BatchNotSupportedError";
    this.provider = provider;
  }
}

export abstract class AnthropicSkillDeliveryError extends Error {
  abstract readonly code: string;
  readonly provider = "anthropic" as const;
}

/**
 * More than Anthropic's hard per-request maximum of 8 Custom Skills were
 * mapped for a single request. This is a defensive fail-loud guard; general
 * rank-and-truncate selection is handled by the request construction path.
 */
export class AnthropicSkillCapError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_skill_cap_exceeded" as const;
  readonly count: number;

  constructor(count: number, catalogSkillIds: string[]) {
    super(
      `Anthropic allows at most 8 Custom Skills per request, but ${count} ` +
        `were mapped: ${catalogSkillIds.join(", ")}. Reduce the per-agent ` +
        `skill set or configure rank-and-truncate selection before using ` +
        `these skills with the Anthropic provider.`,
    );
    this.name = "AnthropicSkillCapError";
    this.count = count;
  }
}

/**
 * A function-tool / shell / read_skill skill tool reached the Anthropic
 * provider. This is structurally forbidden: the Anthropic function-tool skill
 * path is a hard standing invariant that must never be used for skill
 * delivery. Thrown at the provider boundary so EVERY caller (orchestration
 * arms, chat runner, agent-stream, llm-bridge) is covered, regardless of who
 * constructed the tool.
 */
export class AnthropicFunctionToolSkillError extends AnthropicSkillDeliveryError {
  readonly code = "anthropic_function_tool_skill_forbidden" as const;

  constructor(detail: string) {
    super(
      `Anthropic skill delivery via function tools / shell / read_skill is a ` +
        `forbidden standing invariant. Skills must reach Anthropic only via ` +
        `container.skills (LlmContainerSkillsTool). Offending tool: ${detail}.`,
    );
    this.name = "AnthropicFunctionToolSkillError";
  }
}

/**
 * llm-providers S1 (#1712) — native_mcp fail-closed hardening.
 *
 * Thrown when a request carries `capabilityRequired: "native_mcp"` and the
 * Anthropic adapter's native MCP path (`client.beta.messages.create` with
 * `mcp_servers`) fails at runtime (e.g. the account has not enabled the MCP
 * client beta). WITHOUT a native_mcp requirement the adapter silently degrades
 * to the function-tools path; WITH it, that degradation would violate the
 * declared capability contract (function-tool emulation does NOT satisfy
 * native_mcp — the MCP Injection Rule), so the request fails closed instead.
 * Callers convert adapter throws into SSE `error` events / HTTP 5xx.
 */
export class NativeMcpCapabilityRequiredError extends Error {
  readonly code = "native_mcp_capability_required" as const;
  readonly provider: LlmProvider;
  /** The underlying native-path failure, when one triggered the fail-closed. */
  readonly cause?: unknown;

  constructor(provider: LlmProvider, cause?: unknown) {
    super(
      `The request requires the "native_mcp" LLM capability, but provider ` +
        `"${provider}" could not complete its native MCP path` +
        (cause instanceof Error ? `: ${cause.message}` : "") +
        `. Falling back to function-tool emulation would not satisfy ` +
        `native_mcp (function tools are not native MCP), so the request fails ` +
        `closed. Enable the provider's native MCP support or remove the ` +
        `native_mcp capability requirement.`,
    );
    this.name = "NativeMcpCapabilityRequiredError";
    this.provider = provider;
    this.cause = cause;
  }
}

/**
 * llm-providers S2 (#1713, AC2) — an MCP server toolbox declares
 * `approval: "approval_required"`, but the target provider cannot honour an
 * approval step (its declared `approval` capability is "unsupported" —
 * Anthropic today: neither its native `mcp_servers` serialization nor its
 * function-tools emulation carries any approval knob). Silently executing an
 * approval-intending toolbox would auto-run tool calls the operator required
 * approval for, so the request fails closed BEFORE any provider/credential
 * request is issued. Callers convert adapter throws into SSE `error` events /
 * HTTP 5xx.
 */
export class McpApprovalUnsupportedError extends Error {
  readonly code = "mcp_approval_unsupported" as const;
  readonly provider: LlmProvider;
  /** The server labels that declared `approval_required`. */
  readonly serverLabels: string[];

  constructor(provider: LlmProvider, serverLabels: string[]) {
    super(
      `MCP server${serverLabels.length === 1 ? "" : "s"} ` +
        `${serverLabels.map((l) => `"${l}"`).join(", ")} require` +
        `${serverLabels.length === 1 ? "s" : ""} tool-call approval ` +
        `(approval: "approval_required"), but provider "${provider}" cannot ` +
        `honour an approval step (declared approval capability: unsupported). ` +
        `Auto-executing an approval-intending toolbox would drop the approval ` +
        `silently, so the request fails closed. Route the toolbox to a ` +
        `provider that supports approvals, or set approval to "auto_execute".`,
    );
    this.name = "McpApprovalUnsupportedError";
    this.provider = provider;
    this.serverLabels = serverLabels;
  }
}
