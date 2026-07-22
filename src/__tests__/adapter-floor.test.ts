// Anthropic slice of core `packages/llm/src/__tests__/provider-parts.test.ts`,
// relocated with the value floor (llm-providers S4 — cinatra#1715). Covers the
// anthropic provider-native part builder + the shared `resolvedAttachmentsPerMessage`
// helper the adapter depends on. The openai/gemini builder cases stay in core
// (their value slices live in their own connectors).
import { describe, expect, it } from "vitest";
import {
  anthropicUserContent,
  hasAnthropicDocuments,
  resolvedAttachmentsPerMessage,
} from "../adapter/adapter-floor";
import type { AdapterAttachmentPart } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

// Provider-native part builders. The load-bearing guarantee: NO matching
// parts => legacy plain form (request body byte-identical for callers without
// matching provider-native parts).

const oa: AdapterAttachmentPart = {
  nativeKind: "openai_input_file",
  providerFileId: "file_oa1",
  mime: "application/pdf",
};
const an: AdapterAttachmentPart = {
  nativeKind: "anthropic_document",
  providerFileId: "file_an1",
  mime: "application/pdf",
};
const ge: AdapterAttachmentPart = {
  nativeKind: "gemini_file_data",
  providerFileId: "gs://f1",
  mime: "image/png",
};

describe("adapter-floor: anthropic provider-parts", () => {
  it("Anthropic: no parts → bare string; matching → text + document", () => {
    expect(anthropicUserContent("hi", undefined)).toBe("hi");
    expect(anthropicUserContent("hi", [oa])).toBe("hi"); // wrong kind filtered
    expect(anthropicUserContent("doc?", [an])).toEqual([
      { type: "text", text: "doc?" },
      { type: "document", source: { type: "file", file_id: "file_an1" } },
    ]);
    expect(hasAnthropicDocuments([an])).toBe(true);
    expect(hasAnthropicDocuments([oa, ge])).toBe(false);
    expect(hasAnthropicDocuments(undefined)).toBe(false);
  });
});

describe("resolvedAttachmentsPerMessage", () => {
  it("no parts anywhere → all undefined (byte-identical plain text)", () => {
    expect(
      resolvedAttachmentsPerMessage(
        [
          { role: "user" },
          { role: "assistant" },
          { role: "user" },
        ],
        undefined,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("request-level fallback hits ONLY the last user turn", () => {
    const out = resolvedAttachmentsPerMessage(
      [
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
      ],
      [oa],
    );
    expect(out).toEqual([undefined, undefined, [oa]]);
  });

  it("a turn's OWN resolvedAttachments win; fallback never overwrites them", () => {
    const out = resolvedAttachmentsPerMessage(
      [
        { role: "user", resolvedAttachments: [an] },
        { role: "user" },
      ],
      [oa],
    );
    // msg0 keeps its own; msg1 (last user, none of its own) gets fallback
    expect(out).toEqual([[an], [oa]]);
  });

  it("last user turn with its OWN parts does NOT also get the request-level fallback", () => {
    const out = resolvedAttachmentsPerMessage(
      [{ role: "user", resolvedAttachments: [ge] }],
      [oa],
    );
    expect(out).toEqual([[ge]]);
  });

  it("fallback targets the LAST USER turn even if an assistant turn trails it", () => {
    const out = resolvedAttachmentsPerMessage(
      [{ role: "user" }, { role: "assistant" }],
      [oa],
    );
    expect(out).toEqual([[oa], undefined]);
  });

  it("NO user turns at all → request-level fallback is dropped (no misattach)", () => {
    const out = resolvedAttachmentsPerMessage(
      [{ role: "assistant" }, { role: "assistant" }],
      [oa],
    );
    expect(out).toEqual([undefined, undefined]);
  });
});
