"use server";

// Anthropic connection server actions live in this connector package so the
// administration page does not reach outside the package to find them, and so the
// mutation is gated by the per-install extension access policy.

import { z } from "zod";
import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import {
  CLAUDE_MODELS,
  saveAnthropicAPISettings,
  saveDefaultClaudeModel,
  type ClaudeModel,
} from "./index";

const ANTHROPIC_PACKAGE_ID = "@cinatra-ai/anthropic-connector";

const anthropicSettingsSchema = z.object({
  apiKey: z.string().optional(),
  // The connector settings page posts `defaultModel`; persist it via the
  // connector helper so the Claude model select round-trips. (The prior host
  // action also accepted `loggingEnabled`, but the settings form never posts it
  // and routing it required the host `@/lib/logging` module — dropped on relocate.)
  defaultModel: z.string().optional(),
});

export async function saveAnthropicSettingsAction(formData: FormData) {
  // Gate the mutation behind the per-install extension access policy (the prior
  // host action was UNGATED — relocate adds the manage check, matching peers).
  await requireExtensionAction(ANTHROPIC_PACKAGE_ID, "manage");
  const parsed = anthropicSettingsSchema.parse({
    apiKey: formData.get("apiKey") ?? undefined,
    defaultModel: formData.get("defaultModel") ?? undefined,
  });
  try {
    if (parsed.apiKey !== undefined) {
      await saveAnthropicAPISettings({ apiKey: parsed.apiKey });
    }
    if (
      parsed.defaultModel !== undefined &&
      (CLAUDE_MODELS as readonly string[]).includes(parsed.defaultModel)
    ) {
      saveDefaultClaudeModel(parsed.defaultModel as ClaudeModel);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save Anthropic settings.";
    throw new Error(message);
  }
}
