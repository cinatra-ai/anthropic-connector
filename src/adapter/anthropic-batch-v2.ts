/**
 * Anthropic Message Batches ⟷ the provider-neutral batch-v2 contract
 * (cinatra#2396).
 *
 * Every function here is PURE: neutral descriptor in / native params out, or
 * native response in / neutral shape out. The adapter half in
 * `anthropic-adapter.ts` does nothing but call the SDK and hand the payloads to
 * these mappers, which is what makes the whole translation testable against
 * recorded fixtures with no network and no client.
 *
 * WHY ANTHROPIC NEEDED A NEW CONTRACT AT ALL. The shipped v1 batch surface is
 * OpenAI-canonical: an uploaded JSONL INPUT FILE, an eight-value batch
 * lifecycle, and results addressed by OUTPUT/ERROR FILE id. Message Batches
 * differ on every one of those axes —
 *
 *   - requests are submitted INLINE (`messages.batches.create({requests})`),
 *     so there is no input file and nothing to upload;
 *   - the batch lifecycle is `in_progress | canceling | ended`;
 *   - results are streamed back by BATCH id (`messages.batches.results(id)`),
 *     with no separate error file at all;
 *   - each request carries its OWN terminal outcome —
 *     `succeeded | errored | canceled | expired`.
 *
 * The last point is the substantive one: on Anthropic a batch that `ended` may
 * still hold a mix of all four per-request outcomes, so "the batch finished"
 * and "this request succeeded" are genuinely different facts. v2 models them
 * separately for exactly that reason.
 *
 * SANITIZATION. `LlmBatchV2Request.outputSchema` arrives ALREADY SANITIZED for
 * Anthropic from the core→adapter seam (cinatra#2339/#2343). This module emits
 * it VERBATIM into `output_config.format.schema` — the same slot and the same
 * verbatim posture as the non-batch `generateWithFileInput` path — and never
 * re-sanitizes. No sanitizer policy lives in this connector.
 */
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type {
  MessageBatch,
  MessageBatchIndividualResponse,
  BatchCreateParams,
} from "@anthropic-ai/sdk/resources/messages/batches";
import type {
  LlmBatchV2Counts,
  LlmBatchV2Error,
  LlmBatchV2ErrorCode,
  LlmBatchV2Outcome,
  LlmBatchV2Request,
  LlmBatchV2State,
  LlmBatchV2Status,
  LlmUsageData,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

/**
 * Anthropic requires `max_tokens` on every Messages request; the Batches API is
 * no exception. Mirrors the adapter's own non-batch default so a batch request
 * and a synchronous one with the same descriptor behave identically.
 */
export const ANTHROPIC_BATCH_DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/**
 * Neutral descriptor → the native `params` of one inline batch request.
 *
 * `system` rides the top-level Messages `system` field (Anthropic has no
 * "system role" message), and `output_config.format` carries the
 * already-sanitized JSON Schema.
 */
export function toAnthropicBatchRequest(
  request: LlmBatchV2Request,
  fallbackModel: string,
): BatchCreateParams.Request {
  const params: Record<string, unknown> = {
    model: request.model ?? fallbackModel,
    max_tokens: request.maxTokens ?? ANTHROPIC_BATCH_DEFAULT_MAX_TOKENS,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
  if (typeof request.system === "string" && request.system.length > 0) {
    params.system = request.system;
  }
  if (request.temperature !== undefined) {
    params.temperature = request.temperature;
  }
  if (request.outputSchema !== undefined) {
    // VERBATIM — the schema was sanitized core-side. Same slot the non-batch
    // structured path uses.
    params.output_config = {
      format: { type: "json_schema", schema: request.outputSchema },
    };
  }
  return {
    custom_id: request.customId,
    params: params as unknown as MessageCreateParamsNonStreaming,
  };
}

// ---------------------------------------------------------------------------
// Batch state
// ---------------------------------------------------------------------------

/**
 * `processing_status` → the neutral lifecycle.
 *
 * Anthropic has no batch-level `failed`: a batch that was accepted always ends,
 * and failure is reported PER REQUEST. So this mapper never produces `"failed"`
 * — a fact worth stating rather than leaving to inference, since a consumer
 * polling an Anthropic batch will only ever observe three of the four values.
 */
export function toNeutralBatchStatus(
  processingStatus: MessageBatch["processing_status"] | string,
): LlmBatchV2Status {
  switch (processingStatus) {
    case "in_progress":
      return "in_progress";
    case "canceling":
      return "canceling";
    case "ended":
      return "ended";
    default:
      // An unrecognised vendor status is NOT guessed into a terminal state —
      // a poller must keep polling rather than persist a batch as finished on
      // a string this connector does not understand.
      return "in_progress";
  }
}

/** `request_counts` → neutral counts; `total` is the sum, as the API documents. */
export function toNeutralCounts(counts: MessageBatch["request_counts"]): LlmBatchV2Counts {
  const processing = counts.processing ?? 0;
  const succeeded = counts.succeeded ?? 0;
  const errored = counts.errored ?? 0;
  const canceled = counts.canceled ?? 0;
  const expired = counts.expired ?? 0;
  return {
    total: processing + succeeded + errored + canceled + expired,
    processing,
    succeeded,
    errored,
    canceled,
    expired,
  };
}

/**
 * `MessageBatch` → neutral state.
 *
 * `expiresAt` is the PROCESSING-EXPIRY deadline (24h from creation): any request
 * still processing at that moment terminates as an `expired` OUTCOME. Surfacing
 * it is what lets a caller distinguish "still working" from "about to be lost".
 */
export function toNeutralBatchState(batch: MessageBatch): LlmBatchV2State {
  return {
    batchId: batch.id,
    status: toNeutralBatchStatus(batch.processing_status),
    counts: toNeutralCounts(batch.request_counts),
    endedAt: batch.ended_at ?? null,
    expiresAt: batch.expires_at ?? null,
    // Anthropic reports no batch-level error: an accepted batch always ends and
    // failure is a per-request outcome.
    errorMessage: null,
  };
}

// ---------------------------------------------------------------------------
// Per-request outcomes
// ---------------------------------------------------------------------------

/**
 * Anthropic's `ErrorType` union → the STABLE neutral code vocabulary.
 *
 * Keyed on the vendor's own discriminated `error.type`, which is exact — no
 * message-text sniffing, no guessing. An unrecognised type degrades to
 * `"unknown"` while the verbatim vendor type still rides on `providerCode`, so
 * nothing is lost.
 */
export function toNeutralErrorCode(errorType: string | null | undefined): LlmBatchV2ErrorCode {
  switch (errorType) {
    case "invalid_request_error":
      return "invalid_request";
    case "authentication_error":
      return "authentication";
    case "permission_error":
      return "permission";
    case "not_found_error":
      return "not_found";
    case "rate_limit_error":
      return "rate_limit";
    case "timeout_error":
      return "timeout";
    case "overloaded_error":
      return "overloaded";
    case "billing_error":
      return "billing";
    case "api_error":
      return "provider_error";
    default:
      // NOTE the deliberate absence of `request_too_large`: it is a neutral
      // code the OpenAI side can produce, but it is NOT a member of Anthropic's
      // `ErrorType` union, so mapping onto it here would be invention. An
      // oversized Anthropic request comes back as `invalid_request_error`.
      return "unknown";
  }
}

function toNeutralError(error: { type?: string; message?: string } | undefined): LlmBatchV2Error {
  return {
    code: toNeutralErrorCode(error?.type),
    message: error?.message ?? "The provider reported an error with no message.",
    providerCode: error?.type ?? null,
    // The Batches results stream carries no HTTP status per row — the row IS
    // the transport. Reporting null is the honest answer; inventing one would
    // make a consumer's status-based branching wrong.
    providerStatus: null,
  };
}

function extractText(content: Array<{ type?: string; text?: string }> | undefined): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function extractUsage(message: { usage?: Record<string, unknown> }): LlmUsageData | undefined {
  const usage = message.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * One `.jsonl` row of the results stream → one neutral outcome.
 *
 * All four Anthropic result kinds are mapped; `canceled` and `expired` are
 * first-class terminal outcomes on this provider, not derived from a batch-level
 * status, which is precisely why the neutral contract models them per request.
 */
export function toNeutralOutcome(row: MessageBatchIndividualResponse): LlmBatchV2Outcome {
  const customId = row.custom_id;
  const result = row.result;
  switch (result.type) {
    case "succeeded": {
      const message = result.message as unknown as {
        content?: Array<{ type?: string; text?: string }>;
        model?: string;
        stop_reason?: string | null;
        usage?: Record<string, unknown>;
      };
      const usage = extractUsage(message);
      return {
        customId,
        status: "succeeded",
        text: extractText(message.content),
        model: typeof message.model === "string" ? message.model : null,
        ...(usage === undefined ? {} : { usage }),
        stopReason: message.stop_reason ?? null,
        rawBody: JSON.stringify(result.message),
      };
    }
    case "errored": {
      const error = (result.error as { error?: { type?: string; message?: string } } | undefined)
        ?.error;
      return {
        customId,
        status: "errored",
        error: toNeutralError(error),
        rawBody: JSON.stringify(result.error),
      };
    }
    case "canceled":
      return { customId, status: "canceled" };
    case "expired":
      return { customId, status: "expired" };
    default:
      // A result kind this connector does not know is reported as an honest
      // error rather than silently dropped — a dropped row would look to the
      // caller exactly like a request that was never submitted.
      return {
        customId,
        status: "errored",
        error: {
          code: "unknown",
          message: `Unrecognised Anthropic batch result type "${String(
            (result as { type?: unknown }).type,
          )}".`,
          providerCode: null,
          providerStatus: null,
        },
        rawBody: JSON.stringify(result),
      };
  }
}
