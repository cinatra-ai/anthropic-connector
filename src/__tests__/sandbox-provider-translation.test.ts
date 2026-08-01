/**
 * SINGULAR-NATIVE-SHELL battery — Anthropic half (epic cinatra#1705 AC4).
 *
 * REINSTATEMENT, not a new suite. The equivalent battery lived in core at
 * `packages/llm/src/__tests__/sandbox-provider-translation.test.ts` and was
 * DELETED with the in-core adapters in cinatra#1972 (llm-providers S4 /
 * cinatra#1715), leaving the rule as unguarded implementation in
 * `src/adapter/anthropic-adapter.ts`. This file re-establishes the guard where
 * the code now lives, driving the REAL adapter with scripted SDK responses
 * (the SDK is mocked, the adapter is not).
 *
 * The singular-native-shell rule is an OpenAI wire-form rule; Anthropic's
 * obligations under it are the corollaries, and they are what this file pins:
 *   - execution is a plain NAMED function tool with an `input_schema` — never
 *     a native/privileged shell entry, on any posture;
 *   - it SURVIVES native-MCP-mode tool stripping (the strip removes the
 *     non-skill shell tool; `sandbox_execute` must still reach the request —
 *     the reason `sandbox_execution` is its own union member and not the
 *     skill-delivery shell type);
 *   - `tool_use` dispatch routes to the sandbox tool's broker-bound executor
 *     (it is not an `LlmFunctionTool`, so the generic name lookup can never
 *     resolve it), including the `timeout_ms` → `timeoutMs` mapping;
 *   - skill DELIVERY never degrades into a shell here (epic D7): a
 *     skill-bearing shell tool fails CLOSED even when execution is authorized.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LlmMcpServerTool,
  LlmSandboxExecutionTool,
  LlmShellTool,
  SandboxExecuteAction,
  SandboxExecuteOutput,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

const betaCreateMock = vi.fn();
const messagesCreateMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    beta = { messages: { create: betaCreateMock } };
    messages = { create: messagesCreateMock };
    constructor(_config: unknown) {}
  }
  return { default: MockAnthropic };
});

// Telemetry writes log files — no-op in tests.
vi.mock("../telemetry", () => ({
  writeAnthropicLogFile: vi.fn(async () => {}),
}));

import { createAnthropicProviderAdapter } from "../adapter/anthropic-adapter";
import { AnthropicFunctionToolSkillError } from "../adapter/adapter-errors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSandboxTool(): {
  tool: LlmSandboxExecutionTool;
  calls: SandboxExecuteAction[];
} {
  const calls: SandboxExecuteAction[] = [];
  const tool: LlmSandboxExecutionTool = {
    type: "sandbox_execution",
    toolName: "sandbox_execute",
    description: "Execute shell commands in an isolated sandbox.",
    stagedSkills: [
      {
        skillId: "skill-1",
        slug: "my-skill",
        description: "does things",
        resolveFiles: async () => [
          { path: "SKILL.md", content: "# body", digest: "d".repeat(64) },
        ],
      },
    ],
    execute: async (action): Promise<SandboxExecuteOutput[]> => {
      calls.push(action);
      return action.commands.map(() => ({
        stdout: "sandbox-ok",
        stderr: "",
        outcome: { type: "exit" as const, exitCode: 0 },
      }));
    },
  };
  return { tool, calls };
}

/** A shell tool with NO skills — the only shell shape Anthropic tolerates. */
function makeBareShellTool(): { tool: LlmShellTool; calls: SandboxExecuteAction[] } {
  const calls: SandboxExecuteAction[] = [];
  const tool: LlmShellTool = {
    type: "shell",
    skills: [],
    execute: async (action) => {
      calls.push(action as SandboxExecuteAction);
      return action.commands.map(() => ({
        stdout: "reader-ok",
        stderr: "",
        outcome: { type: "exit" as const, exitCode: 0 },
      }));
    },
  };
  return { tool, calls };
}

const MCP_TOOL: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: "cinatra",
  serverUrl: "http://mcp.invalid/api/mcp",
};

const ANTHROPIC_TEXT = {
  content: [{ type: "text", text: "done" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function anthropicAdapter() {
  return createAnthropicProviderAdapter({ apiKey: "k" });
}

function sentTools(
  mock: typeof messagesCreateMock,
  callIndex = 0,
): Array<Record<string, unknown>> {
  const body = mock.mock.calls[callIndex][0] as {
    tools?: Array<Record<string, unknown>>;
  };
  return body.tools ?? [];
}

beforeEach(() => {
  betaCreateMock.mockReset();
  messagesCreateMock.mockReset();
});

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

describe("Anthropic translation — sandbox_execute is a named function tool", () => {
  it("translates sandbox_execution to a plain function tool with input_schema", async () => {
    messagesCreateMock.mockResolvedValue(ANTHROPIC_TEXT);
    const { tool } = makeSandboxTool();

    await anthropicAdapter().generate({ system: "SYS", prompt: "hi", tools: [tool] });

    const def = sentTools(messagesCreateMock).find(
      (t) => t.name === "sandbox_execute",
    );
    expect(def).toBeDefined();
    const schema = def!.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    // `commands` is the contract (required, string array); the optional
    // properties around it are free to grow, so this asserts containment, not
    // a closed key set.
    expect(schema.required).toEqual(["commands"]);
    expect(Object.keys(schema.properties)).toContain("commands");
  });

  it("never emits a native/privileged shell entry for execution", async () => {
    messagesCreateMock.mockResolvedValue(ANTHROPIC_TEXT);
    const { tool } = makeSandboxTool();

    await anthropicAdapter().generate({ system: "SYS", prompt: "hi", tools: [tool] });

    const tools = sentTools(messagesCreateMock);
    // No `type:"shell"` (the OpenAI native form) and no computer-use bash tool.
    expect(tools.some((t) => t.type === "shell")).toBe(false);
    expect(tools.some((t) => String(t.type ?? "").startsWith("bash_"))).toBe(false);
    // The staged skills do NOT leak onto the execution tool's schema —
    // skill delivery on Anthropic is container.skills only (epic D7).
    const def = tools.find((t) => t.name === "sandbox_execute");
    expect(JSON.stringify(def)).not.toContain("my-skill");
  });

  it("survives native MCP-mode tool stripping (shell stripped, sandbox stays)", async () => {
    betaCreateMock.mockResolvedValue(ANTHROPIC_TEXT);
    const { tool: sandbox } = makeSandboxTool();
    // Anthropic must never receive a skill-bearing shell tool; the bare shell
    // exercises the strip without tripping the fail-closed guard.
    const { tool: bareShell } = makeBareShellTool();

    await anthropicAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [MCP_TOOL, bareShell, sandbox],
    });

    const names = sentTools(betaCreateMock).map((t) => t.name ?? t.type);
    expect(names).toContain("sandbox_execute");
    // The shell tool was stripped on the MCP path (no bash function tool).
    expect(names).not.toContain("bash");
  });

  it("fails closed on a skill-bearing shell tool even with execution authorized (D7)", async () => {
    messagesCreateMock.mockResolvedValue(ANTHROPIC_TEXT);
    const { tool: sandbox } = makeSandboxTool();
    const { tool: shell } = makeBareShellTool();
    shell.skills = [
      { name: "my-skill", description: "does things", path: "/skills/my-skill" },
    ];

    await expect(
      anthropicAdapter().generate({
        system: "SYS",
        prompt: "hi",
        tools: [shell, sandbox],
      }),
    ).rejects.toBeInstanceOf(AnthropicFunctionToolSkillError);
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(betaCreateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("Anthropic dispatch", () => {
  it("dispatches a sandbox_execute tool_use to the executor", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    messagesCreateMock
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "sandbox_execute",
            input: { commands: ["pip install requests"], timeout_ms: 4200 },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce(ANTHROPIC_TEXT);

    const res = await anthropicAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [sandbox],
      maxSteps: 3,
    });

    expect(res.text).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["pip install requests"]);
    expect(calls[0].timeoutMs).toBe(4200);
    // The tool_result sent back carries the sandbox stdout.
    const secondBody = messagesCreateMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(secondBody.messages)).toContain("sandbox-ok");
  });

  it("dispatches sandbox_execute on the NATIVE MCP path too", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    betaCreateMock
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "sandbox_execute",
            input: { commands: ["node -v"] },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce(ANTHROPIC_TEXT);

    const res = await anthropicAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [MCP_TOOL, sandbox],
      maxSteps: 3,
    });

    expect(res.text).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["node -v"]);
  });

  it("refuses an empty commands array without touching the executor", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    messagesCreateMock
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu1", name: "sandbox_execute", input: { commands: [] } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce(ANTHROPIC_TEXT);

    await anthropicAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [sandbox],
      maxSteps: 3,
    });

    expect(calls).toHaveLength(0);
    const secondBody = messagesCreateMock.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(secondBody.messages)).toContain("non-empty");
  });
});
