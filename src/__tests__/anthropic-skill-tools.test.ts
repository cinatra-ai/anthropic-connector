// Provider-boundary structural-enforcement slice of core
// `packages/llm/src/__tests__/anthropic-no-function-tool-skills.test.ts`,
// relocated with the `anthropic-skill-tools` leaf (llm-providers S4 —
// cinatra#1715). Covers ONLY the request-translation primitives that moved into
// the connector: container_skills → request-param translation, the hard 8/request
// cap at the provider boundary, and the fail-closed function-tool skill-delivery
// invariant. The skill-DELIVERY seam (AnthropicContainerSkillDelivery, the
// sync-map / rank-and-truncate machinery) stays in core (cinatra#1964) and is
// covered by its own suites there.
import { describe, it, expect } from "vitest";
import {
  isContainerSkillsTool,
  buildContainerSkillsParam,
  CONTAINER_SKILLS_CODE_EXECUTION_ENTRY,
  assertNoFunctionToolSkillDelivery,
} from "../adapter/anthropic-skill-tools";
import { AnthropicSkillCapError } from "../adapter/adapter-errors";
import type {
  LlmContainerSkillsTool,
  LlmShellTool,
  LlmFunctionTool,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

describe("Anthropic provider boundary — structural enforcement", () => {
  it("translateTools(container_skills) emits only code_execution, no function tool", () => {
    const containerTool: LlmContainerSkillsTool = {
      type: "container_skills",
      skills: [{ skillId: "skill_1", version: "v1", catalogSkillId: "@a:1" }],
    };
    expect(isContainerSkillsTool(containerTool)).toBe(true);
    // The ONLY tools[] entry is code_execution — no input_schema function tool.
    expect(CONTAINER_SKILLS_CODE_EXECUTION_ENTRY.type).toBe("code_execution_20250825");
    expect(
      (CONTAINER_SKILLS_CODE_EXECUTION_ENTRY as { input_schema?: unknown }).input_schema,
    ).toBeUndefined();
    // Skill refs go in the top-level container param, NOT tools.
    const containerParam = buildContainerSkillsParam([containerTool]);
    expect(containerParam).toEqual({
      skills: [{ type: "custom", skill_id: "skill_1", version: "v1" }],
    });
  });

  it("buildContainerSkillsParam fails loud (cap) for a raw >8-skill tool from a direct caller", () => {
    const tool: LlmContainerSkillsTool = {
      type: "container_skills",
      skills: Array.from({ length: 9 }, (_, i) => ({
        skillId: `skill_${i}`,
        version: "v1",
        catalogSkillId: `@s:${i}`,
      })),
    };
    expect(() => buildContainerSkillsParam([tool])).toThrow(AnthropicSkillCapError);
  });

  it("assertNoFunctionToolSkillDelivery throws on a skill-bearing shell tool", () => {
    const shellTool: LlmShellTool = {
      type: "shell",
      skills: [{ name: "s", description: "d", path: "/skills/s" }],
      execute: async () => [],
    };
    expect(() => assertNoFunctionToolSkillDelivery([shellTool])).toThrow(
      /forbidden standing invariant/,
    );
  });

  it("assertNoFunctionToolSkillDelivery throws on read_skill / bash function tools", () => {
    const readSkill: LlmFunctionTool = {
      name: "read_skill",
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    const bash: LlmFunctionTool = {
      name: "bash",
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    expect(() => assertNoFunctionToolSkillDelivery([readSkill])).toThrow();
    expect(() => assertNoFunctionToolSkillDelivery([bash])).toThrow();
  });

  it("assertNoFunctionToolSkillDelivery allows non-skill tools through", () => {
    const normalFn: LlmFunctionTool = {
      name: "campaigns_list",
      description: "list campaigns",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    const emptyShell: LlmShellTool = {
      type: "shell",
      skills: [],
      execute: async () => [],
    };
    expect(() =>
      assertNoFunctionToolSkillDelivery([normalFn, emptyShell]),
    ).not.toThrow();
  });
});
