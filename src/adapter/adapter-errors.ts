// Inlined orchestration-layer error classes for the relocated Anthropic
// provider adapter (llm-providers S4 — cinatra#1715). The relocated adapter +
// its `anthropic-skill-tools` leaf throw these; core's `packages/llm/src/errors.ts`
// keeps its in-tree copies until the final core-deletion PR. The ABI leaf
// supplies the TYPES (`LlmProvider`); this module supplies the connector-side
// VALUES — value-importing them from `@cinatra-ai/sdk-extensions` over the
// serverEntry graph is banned, exactly like the `adapter-floor` value slices.
//
// ERROR IDENTITY ACROSS REALMS (cinatra#1715 D1 — RESOLVED by core PR #1969).
// These classes are inlined connector-side, so the relocated adapter throws
// sentinels with a DISTINCT constructor identity from core's originals. The
// stage-1 artifact flagged this as an activation blocker (a connector-realm copy
// fails an `err instanceof CoreClass` check the moment the host resolves this
// adapter, swallowing a fail-loud sentinel to a warning). #1969 fixed it CORE-side
// by replacing every live `instanceof` on these classes with STRUCTURAL
// discriminators that key on the stable fields — `isAnthropicSkillDeliveryError`
// (`.code` ∈ the skill-delivery code set AND `.provider === "anthropic"`),
// `isBatchNotSupportedError` / `isNativeMcpCapabilityRequiredError` /
// `isMcpApprovalUnsupportedError` (`.code`) — exported from `@cinatra-ai/llm`.
// Those fields are realm-independent, so a faithful inlined copy is recognised
// regardless of which module minted it.
//
// The CONTRACT this module must uphold (do NOT drift): every class keeps the
// EXACT `.code` string core's predicate set expects, and the skill-delivery
// subclasses keep `.provider === "anthropic"` (via the abstract base). Adding a
// NEW skill-delivery code is a PAIRED core change — core's drift-guard contract
// test asserts `ANTHROPIC_SKILL_DELIVERY_ERROR_CODES` equals the concrete
// subclass `.code` set (the two skill-delivery codes below —
// `anthropic_skill_cap_exceeded` + `anthropic_function_tool_skill_forbidden` —
// are the pair this adapter throws; the other two codes belong to the
// skill-DELIVERY/-sync seam that stays in core, cinatra#1964, and are not
// inlined here). This connector never CATCHES these sentinels (it only THROWS
// them at the provider boundary), so there is no connector-side `instanceof` to
// convert; any future connector catch MUST use the exported predicates, never
// `instanceof`.

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
