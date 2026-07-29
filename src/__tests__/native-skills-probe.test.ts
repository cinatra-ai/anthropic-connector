/**
 * NATIVE-SKILLS PROBE (cinatra-ai/cinatra#2093, epic #2086 S6).
 *
 * The probe's whole value is that it distinguishes a connection that CAN
 * deliver custom skills from one that merely CLAIMS to. These pin the two
 * halves of that:
 *
 *   - a `function-tools` mcpMode is refused BEFORE any egress (the specific
 *     misconfiguration setup must catch, and the one a declaration cannot see);
 *   - a `native` mcpMode issues a REAL `container.skills` request carrying the
 *     skill id it was given and the exact beta stack the adapter uses.
 *
 * `fetch` is stubbed at the HTTP boundary only — the request the probe would
 * actually put on the wire is asserted, so the test cannot pass on a request
 * shape Anthropic would reject.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connection = {
  value: null as
    | { apiKey: string; defaultModel?: string; mcpMode?: "native" | "function-tools" }
    | null,
};
const storedMode = { value: "function-tools" as "native" | "function-tools" };

vi.mock("../index", () => ({
  getConfiguredAnthropicConnection: async () => connection.value,
  getMcpMode: () => storedMode.value,
}));

import { probeNativeSkills } from "../native-skills-probe";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  connection.value = { apiKey: "sk-ant-test", mcpMode: "native" };
  storedMode.value = "native";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("probeNativeSkills — refuses without egress when skills cannot be delivered", () => {
  it("returns accepted:false mode:function-tools and makes NO request", async () => {
    connection.value = { apiKey: "sk-ant-test", mcpMode: "function-tools" };
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await probeNativeSkills({ skillId: "skill_abc", version: "v1" });

    expect(result.accepted).toBe(false);
    expect(result.mode).toBe("function-tools");
    expect(result.reason).toContain("function-tools");
    // The decisive property: no egress at all. Sending the request here could
    // succeed through emulation and certify a broken configuration.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the STORED mode when the connection carries none", async () => {
    connection.value = { apiKey: "sk-ant-test" };
    storedMode.value = "function-tools";
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect((await probeNativeSkills({ skillId: "skill_abc", version: "v1" })).accepted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns accepted:false with NO key configured, and makes no request", async () => {
    connection.value = null;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await probeNativeSkills({ skillId: "skill_abc", version: "v1" });
    expect(result.accepted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("probeNativeSkills — the REAL container.skills request", () => {
  it("issues a container.skills request carrying the given skill id + the code-execution tool", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await probeNativeSkills({ skillId: "skill_real_123", version: "rev-7" });
    expect(result).toEqual({ accepted: true, mode: "container-skills" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    // The exact beta stack a container.skills request requires — a probe on a
    // different stack would prove something other than what the adapter sends.
    expect(headers["anthropic-beta"]).toContain("skills-2025-10-02");
    expect(headers["anthropic-beta"]).toContain("code-execution-2025-08-25");
    expect(headers["anthropic-beta"]).toContain("files-api-2025-04-14");

    const body = JSON.parse(String(init.body));
    // BOTH halves of the reference, and the EXACT revision the host proved was
    // uploaded — never "latest", which could resolve a different revision.
    expect(body.container.skills).toEqual([
      { type: "custom", skill_id: "skill_real_123", version: "rev-7" },
    ]);
    expect(body.tools).toEqual([
      { type: "code_execution_20250825", name: "code_execution" },
    ]);
    // Smallest viable request — the point is acceptance of the shape, not output.
    expect(body.max_tokens).toBe(1);
  });

  it("reports a REJECTION as data (not a throw) so setup can render a fix-forward", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("skills beta not enabled for this workspace", { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await probeNativeSkills({ skillId: "skill_abc", version: "v1" });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("HTTP 403");
    expect(result.reason).toContain("skills beta not enabled");
  });

  it("REDACTS an api key echoed back in the provider's error body", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{"error":"bad key sk-ant-supersecretvalue123"}', { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await probeNativeSkills({ skillId: "skill_abc", version: "v1" });
    // The reason string is rendered verbatim in the setup UI and written to the
    // readiness receipt — it must never carry a credential.
    expect(result.reason).not.toContain("supersecretvalue123");
    expect(result.reason).toContain("sk-ant-[redacted]");
  });

  it("BOUNDS an unbounded provider error body", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("x".repeat(50_000), { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await probeNativeSkills({ skillId: "skill_abc", version: "v1" });
    expect((result.reason ?? "").length).toBeLessThan(400);
  });

  it("uses the connection's default model when one is stored", async () => {
    connection.value = { apiKey: "sk-ant-test", mcpMode: "native", defaultModel: "claude-opus-4-7" };
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await probeNativeSkills({ skillId: "skill_abc", version: "v1" });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("claude-opus-4-7");
  });

  it("PROPAGATES a transport failure (inconclusive is NOT a pass)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    // A throw signals "could not be performed at all"; the host treats that as
    // fail-closed, distinctly from a clean accepted:false.
    await expect(probeNativeSkills({ skillId: "skill_abc", version: "v1" })).rejects.toThrow(
      /network unreachable/,
    );
  });
});
