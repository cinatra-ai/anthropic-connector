/**
 * cinatra#2396 — the Anthropic Message Batches implementation of the neutral
 * batch-v2 contract.
 *
 * Two layers, deliberately separated:
 *
 *  1. MAPPERS — pure translation, no client, no network. Every Anthropic shape
 *     the API can produce (three `processing_status` values, all four
 *     per-request result kinds, the whole `ErrorType` union) is mapped here, so
 *     a failure in this block is unambiguously a translation defect.
 *
 *  2. ADAPTER — the surface wired onto `createAnthropicProviderAdapter` driven
 *     against a FAKE `client.messages.batches` whose payloads are recorded
 *     Message-Batches fixtures. This is what proves the submit → poll →
 *     retrieve round trip lands normalized outcomes without touching the API.
 *
 * The two shipped invariants this file also guards:
 *   - the v1 batch methods STILL THROW (v2 is additive, never a re-pointing of
 *     the OpenAI-canonical surface at Message Batches);
 *   - `download` on a batch that has not ended raises the recognisable
 *     `batch_results_not_ready` sentinel rather than returning an empty list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import {
  toAnthropicBatchRequest,
  toNeutralBatchState,
  toNeutralBatchStatus,
  toNeutralCounts,
  toNeutralErrorCode,
  toNeutralOutcome,
  ANTHROPIC_BATCH_DEFAULT_MAX_TOKENS,
} from "../adapter/anthropic-batch-v2";
import { createAnthropicProviderAdapter } from "../adapter/anthropic-adapter";

// ---------------------------------------------------------------------------
// Recorded fixtures — the exact shapes api.anthropic.com returns.
// ---------------------------------------------------------------------------

const ENDED_BATCH: MessageBatch = {
  id: "msgbatch_fixture",
  type: "message_batch",
  processing_status: "ended",
  request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 0 },
  created_at: "2026-08-04T08:00:00Z",
  ended_at: "2026-08-04T08:04:00Z",
  expires_at: "2026-08-05T08:00:00Z",
  archived_at: null,
  cancel_initiated_at: null,
  results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_fixture/results",
};

const IN_PROGRESS_BATCH: MessageBatch = {
  ...ENDED_BATCH,
  processing_status: "in_progress",
  request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  ended_at: null,
  results_url: null,
};

const SUCCEEDED_ROW = {
  custom_id: "row-ok",
  result: {
    type: "succeeded",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: '{"answer":"yes"}' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 17,
        output_tokens: 9,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    },
  },
} as unknown as MessageBatchIndividualResponse;

const ERRORED_ROW = {
  custom_id: "row-bad",
  result: {
    type: "errored",
    error: {
      type: "error",
      request_id: "req_1",
      error: { type: "invalid_request_error", message: "model: not-a-real-model" },
    },
  },
} as unknown as MessageBatchIndividualResponse;

const CANCELED_ROW = {
  custom_id: "row-cancel",
  result: { type: "canceled" },
} as unknown as MessageBatchIndividualResponse;

const EXPIRED_ROW = {
  custom_id: "row-expire",
  result: { type: "expired" },
} as unknown as MessageBatchIndividualResponse;

// ---------------------------------------------------------------------------
// 1. MAPPERS
// ---------------------------------------------------------------------------

describe("toAnthropicBatchRequest — neutral descriptor → inline native request", () => {
  it("carries system as the TOP-LEVEL field (Anthropic has no system-role message)", () => {
    const native = toAnthropicBatchRequest(
      {
        customId: "row-1",
        system: "You are terse.",
        messages: [{ role: "user", content: "hi" }],
      },
      "claude-sonnet-4-6",
    );
    expect(native).toEqual({
      custom_id: "row-1",
      params: {
        model: "claude-sonnet-4-6",
        max_tokens: ANTHROPIC_BATCH_DEFAULT_MAX_TOKENS,
        messages: [{ role: "user", content: "hi" }],
        system: "You are terse.",
      },
    });
  });

  it("honours a per-request model override and pinned maxTokens/temperature", () => {
    const native = toAnthropicBatchRequest(
      {
        customId: "row-1",
        model: "claude-opus-4-7",
        maxTokens: 256,
        temperature: 0.1,
        messages: [{ role: "user", content: "hi" }],
      },
      "claude-sonnet-4-6",
    );
    expect(native.params).toMatchObject({
      model: "claude-opus-4-7",
      max_tokens: 256,
      temperature: 0.1,
    });
  });

  it("emits the ALREADY-SANITIZED schema VERBATIM into output_config.format", () => {
    // Core sanitizes at the seam; the connector must neither re-sanitize nor
    // reshape. Same reference in ⇒ same reference out.
    const outputSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      additionalProperties: false,
    };
    const native = toAnthropicBatchRequest(
      { customId: "row-1", messages: [{ role: "user", content: "hi" }], outputSchema },
      "claude-sonnet-4-6",
    );
    const params = native.params as unknown as {
      output_config: { format: { type: string; schema: unknown } };
    };
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema).toBe(outputSchema);
  });

  it("omits system / temperature / output_config entirely when unset", () => {
    const native = toAnthropicBatchRequest(
      { customId: "row-1", messages: [{ role: "user", content: "hi" }] },
      "claude-sonnet-4-6",
    );
    expect(Object.keys(native.params as unknown as object).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
    ]);
  });

  it("preserves multi-turn conversations in order", () => {
    const native = toAnthropicBatchRequest(
      {
        customId: "row-1",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      },
      "claude-sonnet-4-6",
    );
    expect((native.params as unknown as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
  });
});

describe("toNeutralBatchStatus / toNeutralCounts / toNeutralBatchState", () => {
  it.each([
    ["in_progress", "in_progress"],
    ["canceling", "canceling"],
    ["ended", "ended"],
  ] as const)("processing_status %s → %s", (native, neutral) => {
    expect(toNeutralBatchStatus(native)).toBe(neutral);
  });

  it("an unrecognised vendor status stays in_progress — never guessed terminal", () => {
    expect(toNeutralBatchStatus("some_future_state")).toBe("in_progress");
  });

  it("NEVER produces `failed` — Anthropic reports failure PER REQUEST, not per batch", () => {
    for (const status of ["in_progress", "canceling", "ended", "nonsense"]) {
      expect(toNeutralBatchStatus(status)).not.toBe("failed");
    }
  });

  it("counts sum to total exactly as the API documents", () => {
    expect(
      toNeutralCounts({ processing: 1, succeeded: 2, errored: 3, canceled: 4, expired: 5 }),
    ).toEqual({ total: 15, processing: 1, succeeded: 2, errored: 3, canceled: 4, expired: 5 });
  });

  it("maps the full batch envelope, including the processing-expiry deadline", () => {
    expect(toNeutralBatchState(ENDED_BATCH)).toEqual({
      batchId: "msgbatch_fixture",
      status: "ended",
      counts: { total: 2, processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 0 },
      endedAt: "2026-08-04T08:04:00Z",
      expiresAt: "2026-08-05T08:00:00Z",
      errorMessage: null,
    });
  });

  it("a still-running batch reports null endedAt but KEEPS the expiry deadline", () => {
    const state = toNeutralBatchState(IN_PROGRESS_BATCH);
    expect(state.endedAt).toBeNull();
    // The 24h processing-expiry is what turns still-processing rows into
    // `expired` OUTCOMES, so it must stay visible while the batch runs.
    expect(state.expiresAt).toBe("2026-08-05T08:00:00Z");
    expect(state.counts).toMatchObject({ total: 2, processing: 2 });
  });
});

describe("toNeutralErrorCode — Anthropic's ErrorType union → the STABLE vocabulary", () => {
  it.each([
    ["invalid_request_error", "invalid_request"],
    ["authentication_error", "authentication"],
    ["permission_error", "permission"],
    ["not_found_error", "not_found"],
    ["rate_limit_error", "rate_limit"],
    ["timeout_error", "timeout"],
    ["overloaded_error", "overloaded"],
    ["billing_error", "billing"],
    ["api_error", "provider_error"],
  ] as const)("%s → %s", (native, neutral) => {
    expect(toNeutralErrorCode(native)).toBe(neutral);
  });

  it("an unrecognised / missing type degrades to `unknown` (the verbatim type still rides along)", () => {
    expect(toNeutralErrorCode("some_new_error")).toBe("unknown");
    expect(toNeutralErrorCode(undefined)).toBe("unknown");
    expect(toNeutralErrorCode(null)).toBe("unknown");
  });
});

describe("toNeutralOutcome — all four per-request result kinds", () => {
  it("succeeded → text, model, usage, stop reason and the native rawBody", () => {
    expect(toNeutralOutcome(SUCCEEDED_ROW)).toEqual({
      customId: "row-ok",
      status: "succeeded",
      text: '{"answer":"yes"}',
      model: "claude-sonnet-4-6",
      usage: {
        inputTokens: 17,
        outputTokens: 9,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 0,
      },
      stopReason: "end_turn",
      rawBody: JSON.stringify(
        (SUCCEEDED_ROW.result as unknown as { message: unknown }).message,
      ),
    });
  });

  it("errored → the normalized code with the vendor type carried SEPARATELY", () => {
    expect(toNeutralOutcome(ERRORED_ROW)).toMatchObject({
      customId: "row-bad",
      status: "errored",
      error: {
        code: "invalid_request",
        message: "model: not-a-real-model",
        providerCode: "invalid_request_error",
        // The results stream carries no per-row HTTP status — reporting null is
        // the honest answer rather than inventing one.
        providerStatus: null,
      },
    });
  });

  it("canceled / expired are FIRST-CLASS per-request outcomes", () => {
    expect(toNeutralOutcome(CANCELED_ROW)).toEqual({ customId: "row-cancel", status: "canceled" });
    expect(toNeutralOutcome(EXPIRED_ROW)).toEqual({ customId: "row-expire", status: "expired" });
  });

  it("concatenates multiple text blocks and tolerates non-text blocks", () => {
    const row = {
      custom_id: "row-multi",
      result: {
        type: "succeeded",
        message: {
          content: [
            { type: "text", text: "A" },
            { type: "thinking", thinking: "ignored" },
            { type: "text", text: "B" },
          ],
        },
      },
    } as unknown as MessageBatchIndividualResponse;
    expect(toNeutralOutcome(row)).toMatchObject({ text: "AB", model: null, stopReason: null });
  });

  it("a text-free message yields null text rather than an empty string", () => {
    const row = {
      custom_id: "row-empty",
      result: { type: "succeeded", message: { content: [] } },
    } as unknown as MessageBatchIndividualResponse;
    expect(toNeutralOutcome(row)).toMatchObject({ status: "succeeded", text: null });
  });

  it("an UNKNOWN result kind becomes an honest error row — never silently dropped", () => {
    const row = {
      custom_id: "row-future",
      result: { type: "quantum_superposition" },
    } as unknown as MessageBatchIndividualResponse;
    expect(toNeutralOutcome(row)).toMatchObject({
      customId: "row-future",
      status: "errored",
      error: { code: "unknown" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. ADAPTER — the wired surface, driven against recorded fixtures
// ---------------------------------------------------------------------------

const batches = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  results: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { batches };
  },
}));

// Keep the adapter's telemetry writer inert (it would touch the filesystem).
vi.mock("../telemetry", () => ({ writeAnthropicLogFile: vi.fn(async () => {}) }));

/** The results stream is a JSONL decoder — an async iterable, not an array. */
async function* jsonlStream(rows: MessageBatchIndividualResponse[]) {
  for (const row of rows) yield row;
}

beforeEach(() => {
  for (const fn of Object.values(batches)) fn.mockReset();
});

describe("adapter.batchV2 — the wired Message Batches surface", () => {
  const adapter = () =>
    createAnthropicProviderAdapter({ apiKey: "test-key", defaultModel: "claude-sonnet-4-6" });

  it("declares the EXACT version discriminator core probes for", () => {
    expect(adapter().batchV2?.version).toBe(2);
  });

  it("ADDITIVE: the v1 methods still THROW — v2 is not a re-pointing of the OpenAI surface", async () => {
    const a = adapter();
    for (const call of [
      () => a.submitBatch!({ requests: [] }),
      () => a.retrieveBatch!("x"),
      () => a.downloadBatchResults!("f"),
      () => a.cancelBatch!("x"),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "batch_not_supported",
        provider: "anthropic",
      });
    }
    expect(batches.create).not.toHaveBeenCalled();
  });

  it("submit posts INLINE requests (no file upload) and normalizes the status", async () => {
    batches.create.mockResolvedValue({ ...IN_PROGRESS_BATCH, id: "msgbatch_new" });
    const result = await adapter().batchV2!.submit({
      requests: [
        { customId: "row-1", system: "S", messages: [{ role: "user", content: "hi" }] },
        { customId: "row-2", messages: [{ role: "user", content: "yo" }], maxTokens: 32 },
      ],
    });
    expect(batches.create).toHaveBeenCalledWith({
      requests: [
        {
          custom_id: "row-1",
          params: {
            model: "claude-sonnet-4-6",
            max_tokens: ANTHROPIC_BATCH_DEFAULT_MAX_TOKENS,
            messages: [{ role: "user", content: "hi" }],
            system: "S",
          },
        },
        {
          custom_id: "row-2",
          params: {
            model: "claude-sonnet-4-6",
            max_tokens: 32,
            messages: [{ role: "user", content: "yo" }],
          },
        },
      ],
    });
    expect(result).toEqual({ batchId: "msgbatch_new", status: "in_progress" });
  });

  it("submit DROPS best-effort metadata — Message Batches has no slot for it", async () => {
    batches.create.mockResolvedValue(IN_PROGRESS_BATCH);
    await adapter().batchV2!.submit({
      requests: [{ customId: "row-1", messages: [{ role: "user", content: "hi" }] }],
      metadata: { run: "r1" },
    });
    // Stashing it somewhere (a system preamble, a custom_id prefix) would
    // corrupt the request the caller described, so it is dropped outright.
    expect(JSON.stringify(batches.create.mock.calls[0][0])).not.toContain("r1");
  });

  it("retrieve returns neutral status + counts and NO file ids", async () => {
    batches.retrieve.mockResolvedValue(ENDED_BATCH);
    const state = await adapter().batchV2!.retrieve("msgbatch_fixture");
    expect(batches.retrieve).toHaveBeenCalledWith("msgbatch_fixture");
    expect(state).toMatchObject({ status: "ended", counts: { total: 2, succeeded: 1, errored: 1 } });
    expect(JSON.stringify(state)).not.toContain("results_url");
  });

  it("ROUND TRIP: submit → poll to ended → download lands MIXED normalized outcomes", async () => {
    batches.create.mockResolvedValue(IN_PROGRESS_BATCH);
    const submitted = await adapter().batchV2!.submit({
      requests: [{ customId: "row-ok", messages: [{ role: "user", content: "hi" }] }],
    });
    expect(submitted.status).toBe("in_progress");

    // Poll: still running, then ended — exactly what a consumer's loop sees.
    batches.retrieve
      .mockResolvedValueOnce(IN_PROGRESS_BATCH)
      .mockResolvedValueOnce(ENDED_BATCH)
      .mockResolvedValue(ENDED_BATCH);
    expect((await adapter().batchV2!.retrieve(submitted.batchId)).status).toBe("in_progress");
    expect((await adapter().batchV2!.retrieve(submitted.batchId)).status).toBe("ended");

    batches.results.mockResolvedValue(
      jsonlStream([SUCCEEDED_ROW, ERRORED_ROW, CANCELED_ROW, EXPIRED_ROW]),
    );
    const outcomes = await adapter().batchV2!.download(submitted.batchId);
    expect(outcomes.map((o) => [o.customId, o.status])).toEqual([
      ["row-ok", "succeeded"],
      ["row-bad", "errored"],
      ["row-cancel", "canceled"],
      ["row-expire", "expired"],
    ]);
    // PARTIAL SUCCESS: the successful row survives alongside the failures.
    const ok = outcomes.find((o) => o.status === "succeeded");
    expect(ok).toMatchObject({ customId: "row-ok", text: '{"answer":"yes"}' });
  });

  it("download on a batch that has NOT ended raises the recognisable not-ready sentinel", async () => {
    batches.retrieve.mockResolvedValue(IN_PROGRESS_BATCH);
    await expect(adapter().batchV2!.download("msgbatch_fixture")).rejects.toMatchObject({
      code: "batch_results_not_ready",
      provider: "anthropic",
      batchId: "msgbatch_fixture",
      status: "in_progress",
    });
    // Never an empty array, and never a call the API would 404.
    expect(batches.results).not.toHaveBeenCalled();
  });

  it("download refuses while CANCELING too (results only exist once processing ended)", async () => {
    batches.retrieve.mockResolvedValue({ ...IN_PROGRESS_BATCH, processing_status: "canceling" });
    await expect(adapter().batchV2!.download("msgbatch_fixture")).rejects.toMatchObject({
      code: "batch_results_not_ready",
      status: "canceling",
    });
  });

  it("cancel returns the neutral state of the cancelling batch", async () => {
    batches.cancel.mockResolvedValue({
      ...IN_PROGRESS_BATCH,
      processing_status: "canceling",
      cancel_initiated_at: "2026-08-04T08:02:00Z",
    });
    const state = await adapter().batchV2!.cancel!("msgbatch_fixture");
    expect(batches.cancel).toHaveBeenCalledWith("msgbatch_fixture");
    expect(state.status).toBe("canceling");
  });

  it("falls back to the connector's own default model when no descriptor pins one", async () => {
    batches.create.mockResolvedValue(IN_PROGRESS_BATCH);
    const a = createAnthropicProviderAdapter({ apiKey: "k", defaultModel: "claude-opus-4-7" });
    await a.batchV2!.submit({
      requests: [{ customId: "row-1", messages: [{ role: "user", content: "hi" }] }],
    });
    expect(batches.create.mock.calls[0][0].requests[0].params.model).toBe("claude-opus-4-7");
  });
});
