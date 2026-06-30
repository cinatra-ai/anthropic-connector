// Contract fixtures for the declarative setup DSL (cinatra.configSchema).
//
// The Anthropic connector ships a `uiSurface:"schema-config"` declaration
// (cinatra#782) so the host renders its setup page from DATA with NO rebuild —
// retiring the bundled-react settings/setup pages. These tests prove the
// declared `cinatra.configSchema` passes the PUBLIC validation path: the SAME
// fail-closed `validateConfigSchema` the repo's `extension-kind-gate.mjs` runs
// in CI (the rules-only port of the host's `parseSchemaConfig`).

import { describe, expect, it } from "vitest";
// The package.json is the manifest the host materializes; the configSchema under
// `cinatra` is the exact data the renderer parses.
import pkg from "../../package.json" with { type: "json" };
// The repo's standalone, zero-dependency validator (the kind-gate's public path).
import { validateConfigSchema } from "../../extension-kind-gate.mjs";
import { CLAUDE_MODELS } from "../index";

const configSchema = (pkg as { cinatra?: { configSchema?: unknown } }).cinatra
  ?.configSchema;

describe("anthropic-connector cinatra.configSchema", () => {
  it('declares uiSurface:"schema-config" and requests the "ui" + "capabilities" host ports', () => {
    const cinatra = (pkg as { cinatra: Record<string, unknown> }).cinatra;
    expect(cinatra.uiSurface).toBe("schema-config");
    expect(cinatra.requestedHostPorts).toContain("ui");
    expect(cinatra.requestedHostPorts).toContain("capabilities");
  });

  it("the declared configSchema parses with ZERO validation errors", () => {
    expect(validateConfigSchema(configSchema)).toEqual([]);
  });

  it("covers every setup element the API-key connection needs", () => {
    const fields = (configSchema as { fields: Array<Record<string, unknown>> })
      .fields;
    const byKind = (k: string) => fields.filter((f) => f.kind === k);

    // secret api key.
    expect(byKind("secret").map((f) => f.key)).toContain("apiKey");

    // default-model select whose options EXACTLY mirror CLAUDE_MODELS, with a
    // defaultValue that is one of them (so the picker never falls back to an
    // unknown value).
    const select = byKind("select").find((f) => f.key === "defaultModel");
    expect(select).toBeDefined();
    const optionValues = (select!.options as Array<{ value: string }>).map(
      (o) => o.value,
    );
    expect(optionValues).toEqual([...CLAUDE_MODELS]);
    expect(optionValues).toContain(select!.defaultValue);

    // status-probe + readiness advisory, both referencing registered probes.
    expect(byKind("status-probe")[0]?.actionId).toBe("connectionStatus");
    expect(byKind("advisory")[0]?.probeActionId).toBe("connectionServiceReady");

    // save + clear named actions (clear is confirm-gated).
    const namedActions = byKind("named-action");
    const actionIds = namedActions.map((f) => f.actionId);
    expect(actionIds).toEqual(
      expect.arrayContaining(["saveConnection", "clearConnection"]),
    );
    const clear = namedActions.find((f) => f.actionId === "clearConnection");
    expect(clear?.confirm).toBeTruthy();

    // saved / cleared / error banner variants.
    const banner = byKind("banner")[0];
    expect(banner).toBeDefined();
    const variantNames = (banner.variants as Array<{ name: string }>).map(
      (v) => v.name,
    );
    expect(variantNames).toEqual(
      expect.arrayContaining(["saved", "cleared", "error"]),
    );
  });

  describe("validateConfigSchema stays fail-closed", () => {
    const wrap = (field: Record<string, unknown>) => ({ fields: [field] });

    it("rejects a select defaultValue not among the options", () => {
      expect(
        validateConfigSchema(
          wrap({
            kind: "select",
            key: "defaultModel",
            label: "Default model",
            defaultValue: "nope",
            options: [{ value: "claude-opus-4", label: "Opus 4" }],
          }),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("rejects an advisory with an invalid tone", () => {
      expect(
        validateConfigSchema(
          wrap({ kind: "advisory", label: "Note", tone: "fuchsia" }),
        ).length,
      ).toBeGreaterThan(0);
    });

    it("rejects an UNKNOWN key on a field (no executable/HTML carrier smuggled in)", () => {
      for (const evil of ["html", "onClick", "render", "component", "script"]) {
        const errs = validateConfigSchema(
          wrap({ kind: "secret", key: "apiKey", label: "Key", [evil]: "<script>x</script>" }),
        );
        expect(errs.length, `expected ${evil} to be rejected`).toBeGreaterThan(0);
      }
    });
  });
});
