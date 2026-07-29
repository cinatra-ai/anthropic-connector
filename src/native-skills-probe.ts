/**
 * NATIVE-SKILLS PROBE — the `cinatra.llmProvider` ABI v2 surface member
 * (cinatra-ai/cinatra#2093, epic #2086 S6).
 *
 * WHAT IT ANSWERS: does the connection STORED ON THIS INSTANCE actually accept a
 * `container.skills` request right now?
 *
 * WHY A DECLARATION CANNOT ANSWER IT. This connector declares
 * `native_mcp.status: "native"` — a true statement about the connector's
 * capability. But whether skills reach the model depends on the STORED
 * `mcpMode`, which defaults to `"function-tools"`. In that mode the connector
 * reports ready on key presence, passes every declaration check, and then
 * refuses every `container.skills` request. Setup would complete
 * "successfully" while skills silently never reached Claude. Only a real
 * request with a real, already-uploaded skill id tells the two apart.
 *
 * WHY IT MUST NOT FALL BACK. Emulating skills through function tools would make
 * the probe pass in exactly the broken configuration it exists to detect — the
 * MCP Injection Rule. The probe therefore refuses `function-tools` mode BEFORE
 * issuing any request, and otherwise sends a genuine `container.skills` call.
 *
 * The verdict is DATA, not an exception: a negative result returns
 * `{ accepted: false, reason }` so the host's setup saga can render a
 * fix-forward prompt. A THROW means the probe could not be performed at all
 * (transport failure), which the host treats as inconclusive-and-therefore-
 * failed, fail-closed.
 */

import { getConfiguredAnthropicConnection, getMcpMode } from "./index";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
// The exact beta stack a container.skills request requires. Kept in step with
// the adapter's CONTAINER_SKILLS_BETAS — a probe on a different stack would
// prove something other than what the adapter actually sends.
const PROBE_BETAS = [
  "code-execution-2025-08-25",
  "skills-2025-10-02",
  "files-api-2025-04-14",
].join(",");

const DEFAULT_TIMEOUT_MS = 30_000;

export type NativeSkillsProbeResult = {
  accepted: boolean;
  mode?: "container-skills" | "function-tools" | "unknown";
  reason?: string;
};

/**
 * Issue the smallest possible REAL `container.skills` request against the
 * stored connection.
 *
 * `skillId` + `version` MUST name an actually-uploaded revision — the host
 * supplies the pair from the initial sync it just performed, or from a
 * disposable probe skill it created for the purpose. Probing with a fabricated
 * id would exercise the API's 404 path rather than the acceptance path, and
 * probing with an id but no version could resolve a DIFFERENT revision than the
 * one just uploaded (a `container.skills` reference is `{skill_id, version}` —
 * both halves).
 */
export async function probeNativeSkills(input: {
  skillId: string;
  version: string;
  timeoutMs?: number;
}): Promise<NativeSkillsProbeResult> {
  const connection = await getConfiguredAnthropicConnection();
  if (!connection?.apiKey) {
    return {
      accepted: false,
      mode: "unknown",
      reason: "No Anthropic API key is configured, so custom-skill delivery cannot be verified.",
    };
  }

  // The EFFECTIVE mode decides the verdict. Refuse before any egress: sending
  // the request in function-tools mode would either fail confusingly or, worse,
  // succeed through emulation and certify a configuration that cannot deliver
  // skills.
  const mode = connection.mcpMode ?? getMcpMode();
  if (mode !== "native") {
    return {
      accepted: false,
      mode: "function-tools",
      reason:
        "This Anthropic connection's MCP mode is 'function-tools'. In that mode Cinatra cannot deliver custom skills to Claude — every container.skills request is rejected.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": connection.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": PROBE_BETAS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: connection.defaultModel ?? "claude-sonnet-4-6",
        // Smallest viable request: one token out, one word in. The point is
        // whether the API ACCEPTS the container.skills shape, not what Claude
        // says.
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
        tools: [{ type: "code_execution_20250825", name: "code_execution" }],
        container: {
          // The EXACT revision the host proved was uploaded — never "latest",
          // which could resolve a different revision than the one under test.
          skills: [{ type: "custom", skill_id: input.skillId, version: input.version }],
        },
      }),
    });

    if (res.ok) {
      return { accepted: true, mode: "container-skills" };
    }

    const detail = await res.text().catch(() => "");
    return {
      accepted: false,
      mode: "container-skills",
      // Bounded + provider-supplied only: this string is rendered verbatim in
      // the setup UI and written to the readiness receipt, so it must never
      // carry a credential or an unbounded payload.
      reason: `Anthropic rejected a container.skills request (HTTP ${res.status}). ${redactProbeDetail(detail)}`.trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bound + sanitize the provider's error body before it becomes operator-facing
 * text. Truncates hard, and strips anything shaped like a key so a
 * provider-echoed request payload can never surface a credential.
 */
function redactProbeDetail(detail: string): string {
  return detail
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
