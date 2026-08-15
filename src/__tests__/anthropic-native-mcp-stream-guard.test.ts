/**
 * cinatra#2776 item 3 — the Anthropic connector half of "the self-MCP catalog
 * reaches the model as ONE hosted MCP reference, never as inline function
 * schemas".
 *
 * OWNER RULING (2026-08-15): the chat and widget runtimes ALWAYS declare
 * `capabilityRequired: "native_mcp"` for the self-MCP toolbox, so Anthropic's
 * `function-tools` mode is a HARD REFUSAL on those surfaces; function-tools
 * stays available only to callers that opt in EXPLICITLY.
 *
 * The four defects this file pins, all of them live before #2776:
 *   (a) `stream()` had NO capabilityRequired check at all — it went straight to
 *       the credential-bearing MCP `tools/list` fetch and flattened the catalog
 *       into `input_schema` function tools, on the very path browser chat and
 *       the widget use;
 *   (b) the `generate()` guard EXCLUDED container-skills requests, so a
 *       built-in chat assistant (which normally carries container skills) died
 *       on the container-skills error instead of the ruled native_mcp refusal —
 *       fail-closed by accident, not by contract;
 *   (c) a native-mode stream carrying self-MCP but no container skills took the
 *       GA `client.messages.stream` path, which has no `mcp_servers` param —
 *       the catalog was silently DROPPED rather than sent as one hosted
 *       reference;
 *   (d) `getMcpMode()` reported an unset setting as `"function-tools"` while the
 *       adapter's effective default is `"native"`, so readiness/probe could
 *       disagree with dispatch.
 *
 * The NEGATIVE CONTROL at the bottom is the connector-level twin of the host
 * gate's synthetic flattening case: with function-tools EXPLICITLY allowed and
 * no native_mcp requirement, a synthetic `tools/list` returning policy-shaped
 * names really is flattened — and the diagnostic (the request log the adapter
 * writes) NAMES the flattened tools, so a regression is diagnosable from the
 * artifact alone rather than inferred.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  LlmMcpServerTool,
  LlmContainerSkillsTool,
  LlmTool,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

// ---------------------------------------------------------------------------
// SDK mock — all four entry points the adapter can reach, so "which path did
// this request take" is an assertion rather than an inference.
// ---------------------------------------------------------------------------
const betaCreateMock = vi.fn();
const messagesCreateMock = vi.fn();
const betaStreamMock = vi.fn();
const gaStreamMock = vi.fn();
// The credential-bearing MCP `tools/list` fetch — the egress every fail-closed
// case must prove never happened.
const fetchMock = vi.fn();
// The adapter's request/response log writer: the DIAGNOSTIC surface.
type LogCall = { label: string; kind: "request" | "response"; body: unknown };
const writeLogMock = vi.fn(async (_input: LogCall) => {});

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    beta = { messages: { create: betaCreateMock, stream: betaStreamMock } };
    messages = { create: messagesCreateMock, stream: gaStreamMock };
    constructor(_config: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock("../telemetry", () => ({
  writeAnthropicLogFile: (input: unknown) => writeLogMock(input as never),
}));

import { createAnthropicProviderAdapter } from "../adapter/anthropic-adapter";
import {
  NativeMcpCapabilityRequiredError,
  AnthropicFunctionToolSkillError,
} from "../adapter/adapter-errors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_TOOL: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: "cinatra",
  serverUrl: "http://mcp.invalid/api/mcp",
  headers: { Authorization: "Bearer test" },
};

const CONTAINER_SKILLS_TOOL: LlmContainerSkillsTool = {
  type: "container_skills",
  skills: [{ skillId: "skill_abc", version: "v1", catalogSkillId: "cat/abc" }],
};

/**
 * Policy-shaped self-MCP primitive names. These stand in for the authoritative
 * chat/widget allowed set the HOST gate reads from
 * `delegatedWidgetAllowedToolNames(kind)` / the chat equivalent — connector-side
 * their only job is to be recognisable in a diagnostic.
 */
const POLICY_TOOL_NAMES = [
  "cinatra_list_artifacts",
  "cinatra_get_artifact",
  "cinatra_run_agent",
] as const;

const TERMINAL_MESSAGE = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

const STANDARD_RESPONSE = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** A minimal stand-in for the SDK's MessageStream: async-iterable + finalMessage(). */
function fakeStream(final: unknown = TERMINAL_MESSAGE) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "ok" },
      };
    },
    finalMessage: async () => final,
  };
}

const streamCallbacks = () => ({
  onTextDelta: vi.fn(),
  onToolCall: vi.fn(),
  onToolResult: vi.fn(),
  onStepStart: vi.fn(),
  onStepEnd: vi.fn(),
  onError: vi.fn(),
});

/** The request body the adapter logged for step 1 — the diagnostic artifact. */
function loggedRequestBody(): Record<string, unknown> | undefined {
  const call = writeLogMock.mock.calls.find((c) => c[0]?.kind === "request");
  return call?.[0]?.body as Record<string, unknown> | undefined;
}

/** Every `input_schema`-bearing (i.e. FLATTENED) tool name in a tools array. */
function inlineFunctionToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (t): t is { name: string } =>
        typeof t === "object" &&
        t !== null &&
        "input_schema" in (t as Record<string, unknown>) &&
        typeof (t as { name?: unknown }).name === "string",
    )
    .map((t) => t.name);
}

beforeEach(() => {
  betaCreateMock.mockReset();
  messagesCreateMock.mockReset();
  betaStreamMock.mockReset();
  gaStreamMock.mockReset();
  fetchMock.mockReset();
  writeLogMock.mockClear();

  // Default synthetic self-MCP catalog: policy-shaped names with real schemas.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      result: {
        tools: POLICY_TOOL_NAMES.map((name) => ({
          name,
          description: `${name} description`,
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
        })),
      },
    }),
  });
  vi.stubGlobal("fetch", fetchMock);

  betaCreateMock.mockResolvedValue(STANDARD_RESPONSE);
  messagesCreateMock.mockResolvedValue(STANDARD_RESPONSE);
  betaStreamMock.mockImplementation(() => fakeStream());
  gaStreamMock.mockImplementation(() => fakeStream());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Nothing left the process: no provider call, no MCP tools/list fetch. */
function expectZeroEgress() {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(betaStreamMock).not.toHaveBeenCalled();
  expect(gaStreamMock).not.toHaveBeenCalled();
  expect(betaCreateMock).not.toHaveBeenCalled();
  expect(messagesCreateMock).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// (a) stream-side native_mcp guard — the path that had none
// ---------------------------------------------------------------------------

describe("#2776 3(a) — stream() refuses native_mcp under function-tools mode BEFORE any tools/list fetch", () => {
  it("stream + function-tools + self-MCP + native_mcp (no container skills) → hard refusal, zero egress", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await expect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
        ...streamCallbacks(),
      } as never),
    ).rejects.toBeInstanceOf(NativeMcpCapabilityRequiredError);

    expectZeroEgress();
  });

  it("the stream refusal carries the SAME error class + code as generate()", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    const err = await adapter
      .stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
        ...streamCallbacks(),
      } as never)
      .then(
        () => null,
        (e: unknown) => e as NativeMcpCapabilityRequiredError,
      );

    expect(err).toBeInstanceOf(NativeMcpCapabilityRequiredError);
    expect(err?.code).toBe("native_mcp_capability_required");
    expect(err?.provider).toBe("anthropic");
  });

  it("CONTROL: stream + function-tools + self-MCP with capabilityRequired ABSENT still flattens (behavior-identical)", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL],
      // no capabilityRequired — an old host, or a caller that pinned nothing
      ...streamCallbacks(),
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(gaStreamMock).toHaveBeenCalled();
  });

  it("CONTROL: an EXPLICIT function_tools opt-in is not refused", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL],
      capabilityRequired: "function_tools",
      ...streamCallbacks(),
    } as never);

    expect(gaStreamMock).toHaveBeenCalled();
  });

  it("CONTROL: native_mcp with NO MCP server present is not refused (nothing to flatten)", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(gaStreamMock).toHaveBeenCalled();
  });

  it("CONTROL: native mode + native_mcp streams normally (no refusal)", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    expect(betaStreamMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) the guard is UNIVERSAL — container skills no longer excluded
// ---------------------------------------------------------------------------

describe("#2776 3(b) — the native_mcp guard is universal whenever an MCP server is present", () => {
  it("stream + container skills + function-tools + native_mcp → native_mcp refusal (NOT the skill error)", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    const err = await adapter
      .stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [MCP_TOOL, CONTAINER_SKILLS_TOOL],
        capabilityRequired: "native_mcp",
        ...streamCallbacks(),
      } as never)
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(NativeMcpCapabilityRequiredError);
    expect(err).not.toBeInstanceOf(AnthropicFunctionToolSkillError);
    expect((err as NativeMcpCapabilityRequiredError).code).toBe(
      "native_mcp_capability_required",
    );
    expectZeroEgress();
  });

  it("generate + container skills + function-tools + native_mcp → native_mcp refusal (NOT the skill error)", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    const err = await adapter
      .generate({
        system: "s",
        prompt: "p",
        tools: [MCP_TOOL, CONTAINER_SKILLS_TOOL],
        capabilityRequired: "native_mcp",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(NativeMcpCapabilityRequiredError);
    expect(err).not.toBeInstanceOf(AnthropicFunctionToolSkillError);
    expectZeroEgress();
  });

  it("generate + self-MCP + function-tools + native_mcp (no container skills) still refuses (#1712 pin)", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await expect(
      adapter.generate({
        system: "s",
        prompt: "p",
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
      }),
    ).rejects.toBeInstanceOf(NativeMcpCapabilityRequiredError);
    expectZeroEgress();
  });

  it("CONTROL: container skills + function-tools WITHOUT a requirement still fails on the skill error", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await expect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [MCP_TOOL, CONTAINER_SKILLS_TOOL],
        ...streamCallbacks(),
      }),
    ).rejects.toBeInstanceOf(AnthropicFunctionToolSkillError);
  });
});

// ---------------------------------------------------------------------------
// (c) native-MCP streams route through beta.messages.stream
// ---------------------------------------------------------------------------

describe("#2776 3(c) — native mode with MCP servers streams through beta.messages.stream", () => {
  it("native + self-MCP, NO container skills → beta stream carrying mcp_servers + one mcp_toolset; GA stream untouched", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    expect(gaStreamMock).not.toHaveBeenCalled();
    expect(betaStreamMock).toHaveBeenCalledTimes(1);

    const body = betaStreamMock.mock.calls[0][0] as Record<string, unknown>;
    expect(body.mcp_servers).toEqual([
      {
        name: "cinatra",
        type: "url",
        url: "http://mcp.invalid/api/mcp",
        authorization_token: "test",
      },
    ]);
    const toolsets = (body.tools as Array<{ type?: string; mcp_server_name?: string }>).filter(
      (t) => t.type === "mcp_toolset",
    );
    expect(toolsets).toEqual([{ type: "mcp_toolset", mcp_server_name: "cinatra" }]);
    expect(body.betas).toContain("mcp-client-2025-11-20");
    // ONE hosted reference, ZERO flattened schemas.
    expect(inlineFunctionToolNames(body.tools)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("native + self-MCP + container skills → beta stream keeps the container param and the skills beta stack", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL, CONTAINER_SKILLS_TOOL],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    expect(betaStreamMock).toHaveBeenCalledTimes(1);
    const body = betaStreamMock.mock.calls[0][0] as Record<string, unknown>;
    expect(body.container).toEqual({
      skills: [{ type: "custom", skill_id: "skill_abc", version: "v1" }],
    });
    expect(body.betas).toEqual(
      expect.arrayContaining([
        "mcp-client-2025-11-20",
        "code-execution-2025-08-25",
        "skills-2025-10-02",
        "files-api-2025-04-14",
      ]),
    );
    expect(inlineFunctionToolNames(body.tools)).toEqual([]);
  });

  it("honours the client-side allowedTools hint on the mcp_toolset entry", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [{ ...MCP_TOOL, allowedTools: ["cinatra_get_artifact"] }],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    const body = betaStreamMock.mock.calls[0][0] as Record<string, unknown>;
    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual({
      type: "mcp_toolset",
      mcp_server_name: "cinatra",
      default_config: { enabled: false },
      configs: { cinatra_get_artifact: { enabled: true } },
    });
  });

  it("CONTROL: a native stream with NO MCP server and no skills stays on the GA path", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [],
      ...streamCallbacks(),
    });

    expect(gaStreamMock).toHaveBeenCalledTimes(1);
    expect(betaStreamMock).not.toHaveBeenCalled();
    expect(gaStreamMock.mock.calls[0][0]).not.toHaveProperty("mcp_servers");
  });
});

// ---------------------------------------------------------------------------
// (d) no function-tools fallback under native_mcp
// ---------------------------------------------------------------------------

describe("#2776 3(d) — a native_mcp stream never reaches the function-tools bridge", () => {
  it("a failing native stream under native_mcp surfaces the error and never fetches tools/list", async () => {
    betaStreamMock.mockImplementation(() => {
      throw new Error("mcp-client beta not enabled");
    });
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });
    const cbs = streamCallbacks();

    await expect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
        ...cbs,
      } as never),
    ).rejects.toThrow("mcp-client beta not enabled");

    // The decisive property: no degradation was attempted.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gaStreamMock).not.toHaveBeenCalled();
  });

  it("generate: a native-path runtime failure under native_mcp fails closed instead of flattening", async () => {
    betaCreateMock.mockRejectedValue(new Error("mcp-client beta not enabled"));
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await expect(
      adapter.generate({
        system: "s",
        prompt: "p",
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
      }),
    ).rejects.toBeInstanceOf(NativeMcpCapabilityRequiredError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — prove the assertion can fire, and that it NAMES the tools
// ---------------------------------------------------------------------------

describe("#2776 connector NEGATIVE CONTROL — flattening is detectable and NAMED", () => {
  it("stream, function-tools ALLOWED: the synthetic policy-named tools/list really is flattened, and the diagnostic names them", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL],
      // No requirement: this configuration is the LEGITIMATE explicit opt-in,
      // so flattening is expected here — the point is that when it happens it
      // is visible and named.
      ...streamCallbacks(),
    });

    // 1. It reached the wire as inline schemas.
    const wireBody = gaStreamMock.mock.calls[0][0] as Record<string, unknown>;
    const wireNames = inlineFunctionToolNames(wireBody.tools);
    expect(wireNames).toEqual([...POLICY_TOOL_NAMES]);

    // 2. The DIAGNOSTIC — the request log the adapter writes — names each one,
    //    so a regression is identifiable from the artifact alone.
    const diagnostic = loggedRequestBody();
    const diagnosticNames = inlineFunctionToolNames(diagnostic?.tools);
    expect(diagnosticNames).toEqual([...POLICY_TOOL_NAMES]);
    for (const name of POLICY_TOOL_NAMES) {
      expect(JSON.stringify(diagnostic)).toContain(name);
    }

    // 3. And it carried NO hosted MCP reference — the two shapes are mutually
    //    exclusive, which is what makes the host gate's count assertion sound.
    expect(wireBody).not.toHaveProperty("mcp_servers");
  });

  it("generate, function-tools ALLOWED: same flattening, same naming", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await adapter.generate({ system: "s", prompt: "p", tools: [MCP_TOOL] });

    const wireBody = messagesCreateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inlineFunctionToolNames(wireBody.tools)).toEqual([...POLICY_TOOL_NAMES]);
    expect(inlineFunctionToolNames(loggedRequestBody()?.tools)).toEqual([
      ...POLICY_TOOL_NAMES,
    ]);
  });

  it("POSITIVE twin: under native_mcp the same fixture yields ZERO inline schemas and one hosted reference", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    const wireBody = betaStreamMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inlineFunctionToolNames(wireBody.tools)).toEqual([]);
    expect((wireBody.mcp_servers as unknown[]).length).toBe(1);
    const diagnostic = loggedRequestBody();
    expect(inlineFunctionToolNames(diagnostic?.tools)).toEqual([]);
    for (const name of POLICY_TOOL_NAMES) {
      expect(JSON.stringify(diagnostic)).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-MCP function tools are NOT the thing being forbidden
// ---------------------------------------------------------------------------

describe("#2776 — legitimate non-catalog function tools are untouched", () => {
  it("an agent-declared function tool still rides alongside the hosted MCP reference on a native stream", async () => {
    const agentTool: LlmTool = {
      name: "agent_local_tool",
      description: "an agent-declared tool, not a self-MCP primitive",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await adapter.stream({
      system: "s",
      messages: [{ role: "user", content: "p" }],
      tools: [MCP_TOOL, agentTool],
      capabilityRequired: "native_mcp",
      ...streamCallbacks(),
    } as never);

    const body = betaStreamMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inlineFunctionToolNames(body.tools)).toEqual(["agent_local_tool"]);
    expect((body.mcp_servers as unknown[]).length).toBe(1);
  });
});
