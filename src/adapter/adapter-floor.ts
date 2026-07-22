// Inlined value floor for the relocated Anthropic provider adapter
// (llm-providers S4 — cinatra#1715). PR-0 moved the ADAPTER TYPE closure to the
// sdk-extensions ABI leaf (`@cinatra-ai/sdk-extensions/llm-provider-adapter-contract`),
// but the small VALUE slices the adapter needs still live in the host's
// `packages/llm` (`attachments/provider-parts`, `execution-plane/tool`) and are
// NOT connector-importable. So each connector inlines its provider-relevant value
// slices verbatim: the ABI leaf supplies the TYPES; this module supplies the
// VALUES. Byte-faithful relocation — zero behavior change (core keeps its in-tree
// copy until the final core-deletion PR).

import type { AdapterAttachmentPart } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

// ---------------------------------------------------------------------------
// Provider-native part builders (anthropic slice of packages/llm
// `attachments/provider-parts.ts`)
// ---------------------------------------------------------------------------
//
// Pure provider-native part builders. Each takes the user prompt text +
// the resolved attachment parts and returns the provider's user-message
// content. CRITICAL: when there are no
// matching parts the return is the LEGACY plain form (a bare string for
// OpenAI/Anthropic, a single text part for Gemini) so the request body is
// BYTE-IDENTICAL for every existing caller. The separate
// `generateWithFileInput` path is untouched and unrelated.

function partsOf(
  resolved: AdapterAttachmentPart[] | undefined,
  nativeKind: string,
): AdapterAttachmentPart[] {
  return (resolved ?? []).filter((p) => p.nativeKind === nativeKind);
}

/**
 * Defines which resolved parts apply to each message, as an array aligned
 * to `messages`. Every user turn uses its OWN
 * resolvedAttachments; the request-level fallback applies to the LAST user
 * turn ONLY when that message carried none. An `undefined` entry ⇒ the caller emits the plain text form
 * (byte-identical). Single source of truth for all three stream builders.
 */
export function resolvedAttachmentsPerMessage(
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    resolvedAttachments?: AdapterAttachmentPart[];
  }>,
  requestLevel: AdapterAttachmentPart[] | undefined,
): Array<AdapterAttachmentPart[] | undefined> {
  const out: Array<AdapterAttachmentPart[] | undefined> = messages.map((m) =>
    m.role === "user" &&
    m.resolvedAttachments &&
    m.resolvedAttachments.length > 0
      ? m.resolvedAttachments
      : undefined,
  );
  if (requestLevel && requestLevel.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        if (out[i] === undefined) out[i] = requestLevel;
        break;
      }
    }
  }
  return out;
}

export function anthropicUserContent(
  promptText: string,
  resolved: AdapterAttachmentPart[] | undefined,
):
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "document";
          source: { type: "file"; file_id: string };
        }
    > {
  const docs = partsOf(resolved, "anthropic_document");
  if (docs.length === 0) return promptText; // legacy: bare string
  return [
    { type: "text", text: promptText },
    ...docs.map((d) => ({
      type: "document" as const,
      source: { type: "file" as const, file_id: d.providerFileId },
    })),
  ];
}

/** True when any Anthropic document parts are present (→ Files API beta). */
export function hasAnthropicDocuments(
  resolved: AdapterAttachmentPart[] | undefined,
): boolean {
  return partsOf(resolved, "anthropic_document").length > 0;
}

// ---------------------------------------------------------------------------
// Sandbox-execute tool name (from packages/llm `execution-plane/tool.ts`)
// ---------------------------------------------------------------------------

/** The single, contractual tool name for the execution capability. */
export const SANDBOX_EXECUTE_TOOL_NAME = "sandbox_execute" as const;
