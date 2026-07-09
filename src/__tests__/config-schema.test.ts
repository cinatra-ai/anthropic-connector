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

    // ---- tabs (cinatra#1102 grouping) ----

    it("rejects tabs that is not an array", () => {
      expect(validateConfigSchema({ fields: [{ kind: "text", key: "a", label: "A" }], tabs: "nope" }).length).toBeGreaterThan(0);
    });

    it("rejects a duplicate tab id", () => {
      const errs = validateConfigSchema({
        fields: [{ kind: "text", key: "a", label: "A" }],
        tabs: [
          { id: "skills", label: "Skills", fields: [{ kind: "boolean", key: "b1", label: "B1" }] },
          { id: "skills", label: "Skills Again", fields: [{ kind: "boolean", key: "b2", label: "B2" }] },
        ],
      });
      expect(errs.length).toBeGreaterThan(0);
    });

    it("rejects an UNKNOWN key on a tab (no executable/HTML carrier smuggled in)", () => {
      const errs = validateConfigSchema({
        fields: [{ kind: "text", key: "a", label: "A" }],
        tabs: [{ id: "skills", label: "Skills", fields: [{ kind: "boolean", key: "b1", label: "B1" }], onClick: "x" }],
      });
      expect(errs.length).toBeGreaterThan(0);
    });

    it("rejects a tab with an empty fields array", () => {
      const errs = validateConfigSchema({
        fields: [{ kind: "text", key: "a", label: "A" }],
        tabs: [{ id: "help", label: "Help", fields: [] }],
      });
      expect(errs.length).toBeGreaterThan(0);
    });

    it("rejects a field key duplicated ACROSS the base fields and a tab (one flat submit namespace)", () => {
      const errs = validateConfigSchema({
        fields: [{ kind: "text", key: "dup", label: "A" }],
        tabs: [{ id: "skills", label: "Skills", fields: [{ kind: "boolean", key: "dup", label: "B" }] }],
      });
      expect(errs.length).toBeGreaterThan(0);
    });

    it("accepts the boolean/dynamic-select-options/number/free-list kinds cinatra#782 added", () => {
      expect(
        validateConfigSchema({
          fields: [
            { kind: "boolean", key: "b", label: "B", defaultValue: false },
            { kind: "number", key: "n", label: "N", min: 0, max: 10, step: 1, defaultValue: 5 },
            { kind: "free-list", key: "f", label: "F" },
            { kind: "dynamic-select-options", key: "d", label: "D", optionsAction: "listOptions" },
          ],
        }),
      ).toEqual([]);
    });
  });

  describe("tabs — Skills + Help (cinatra-ai/cinatra#44)", () => {
    const tabs = (configSchema as { tabs?: Array<Record<string, unknown>> }).tabs ?? [];
    const byId = (id: string) => tabs.find((t) => t.id === id);

    it("declares exactly the Skills and Help tabs", () => {
      expect(tabs.map((t) => t.id)).toEqual(["skills", "help"]);
    });

    it("Skills tab carries the sync-enabled toggle, a capability-gated advisory, and its own save + banner", () => {
      const skills = byId("skills");
      expect(skills).toBeDefined();
      const fields = skills!.fields as Array<Record<string, unknown>>;
      const byKind = (k: string) => fields.filter((f) => f.kind === k);

      const toggle = byKind("boolean").find((f) => f.key === "skillSyncEnabled");
      expect(toggle).toBeDefined();
      expect(toggle?.defaultValue).toBe(false);

      const advisory = byKind("advisory")[0];
      expect(advisory?.probeActionId).toBe("skillsCapabilityReady");
      expect(advisory?.whenReady).toMatch(/not ZDR-eligible/i);
      expect(advisory?.whenNotReady).toMatch(/not available/i);

      const namedActions = byKind("named-action");
      expect(namedActions.map((f) => f.actionId)).toContain("saveSkills");

      const banner = byKind("banner")[0];
      const variantNames = (banner!.variants as Array<{ name: string }>).map((v) => v.name);
      expect(variantNames).toEqual(expect.arrayContaining(["skillsSaved", "skillsUnavailable", "error"]));
    });

    it("Help tab is read-only (no named-action / no Save) and carries the setup how-to", () => {
      const help = byId("help");
      expect(help).toBeDefined();
      const fields = help!.fields as Array<Record<string, unknown>>;
      expect(fields.every((f) => f.kind === "advisory")).toBe(true);
      expect(fields.some((f) => (f.whenReady as string).includes("console.anthropic.com"))).toBe(true);
    });

    it("every declared action id used by a tab field is registered by register.ts's ctx.ui.registerAction calls", async () => {
      // Cross-check against the source text rather than importing register.ts
      // (which requires a full ExtensionHostContext) — every actionId/
      // probeActionId declared in the manifest must have a matching
      // `id: "<name>"` registration, or the host action-dispatch endpoint would
      // 404 it at runtime.
      const fs = await import("node:fs");
      const registerSrc = fs.readFileSync(new URL("../register.ts", import.meta.url), "utf8");
      const allTabFields = tabs.flatMap((t) => t.fields as Array<Record<string, unknown>>);
      const actionIds = new Set<string>();
      for (const f of allTabFields) {
        if (typeof f.actionId === "string") actionIds.add(f.actionId);
        if (typeof f.probeActionId === "string") actionIds.add(f.probeActionId);
      }
      expect(actionIds.size).toBeGreaterThan(0);
      for (const id of actionIds) {
        expect(registerSrc, `expected register.ts to register action "${id}"`).toMatch(
          new RegExp(`id:\\s*"${id}"`),
        );
      }
    });
  });
});
