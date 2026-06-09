# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (configured via `package.json` scripts: `"test": "vitest"`)
- No local `vitest.config.*` file found — Vitest runs with defaults or inherits config from the monorepo host

**Assertion Library:**
- Vitest built-in (`expect`)

**Run Commands:**
```bash
npm test        # Run all tests (vitest)
npx vitest      # Direct vitest invocation
```

## Test File Organization

**Location:** No test files exist in this repository at this time. The test infrastructure (Vitest) is configured but no test suite has been written yet.

**Expected naming pattern (based on package structure):**
- Co-located test files alongside source: `src/index.test.ts`, `src/deps.test.ts`
- Or a separate `__tests__/` directory at repo root

**Structure:**
```
src/
├── index.ts
├── deps.ts         # Exports _resetAnthropicDepsForTests — designed to be tested
├── actions.ts
├── setup-page.tsx
├── settings-page.tsx
└── components/ui/
```

## Test Structure

**Suite Organization:**
Not applicable — no test files present.

**Patterns indicated by source code:**
- `src/deps.ts` exports `_resetAnthropicDepsForTests()` (line 97), which sets the global deps slot to `null`. This is the designated teardown helper for any test that calls `registerAnthropicConnector(deps)`.
- Tests are expected to register a stub deps object via `registerAnthropicConnector(mockDeps)` and tear down via `_resetAnthropicDepsForTests()`.

Expected pattern based on the `_reset` helper:
```typescript
import { registerAnthropicConnector, _resetAnthropicDepsForTests } from "./deps";

beforeEach(() => {
  registerAnthropicConnector(mockDeps);
});

afterEach(() => {
  _resetAnthropicDepsForTests();
});
```

## Mocking

**Framework:** Vitest (built-in `vi.fn()`, `vi.mock()`)

**Patterns indicated by source code:**
- Dependency injection via `registerAnthropicConnector(deps)` is the primary seam for testing. Tests swap in stub implementations of `AnthropicConnectorDeps` without touching globalThis directly.
- The `AnthropicConnectorDeps` interface in `src/deps.ts` defines all injectable surfaces: `readConnectorConfigFromDatabase`, `writeConnectorConfigToDatabase`, `readAnthropicConnectionFromDatabase`, `isAppDevelopmentMode`, and `nango` (an `AnthropicNangoCapability` object).
- The `AnthropicNangoCapability` interface provides all Nango methods as mockable function signatures.

**What to Mock:**
- The full `AnthropicConnectorDeps` object passed to `registerAnthropicConnector`
- Individual `nango.*` methods (`isConfigured`, `getPrimarySavedConnection`, `getCredentials`, etc.) within the deps stub

**What NOT to Mock:**
- Internal pure logic in `src/index.ts` (model selection, settings merging) — test these by injecting controlled deps and asserting return values

## Fixtures and Factories

**Test Data:**
Not applicable — no test files present.

**Recommended pattern based on the `AnthropicConnectorDeps` interface:**
```typescript
function makeMockDeps(overrides?: Partial<AnthropicConnectorDeps>): AnthropicConnectorDeps {
  return {
    readConnectorConfigFromDatabase: vi.fn().mockReturnValue({}),
    writeConnectorConfigToDatabase: vi.fn(),
    readAnthropicConnectionFromDatabase: vi.fn().mockReturnValue(null),
    isAppDevelopmentMode: vi.fn().mockReturnValue(false),
    nango: {
      isConfigured: vi.fn().mockReturnValue(false),
      getStatus: vi.fn().mockReturnValue({ status: "not_connected", detail: "" }),
      getFrontendConfig: vi.fn().mockReturnValue({}),
      getPrimarySavedConnection: vi.fn().mockReturnValue(null),
      getCredentials: vi.fn().mockResolvedValue(null),
      ensureIntegration: vi.fn().mockResolvedValue(undefined),
      importConnection: vi.fn().mockResolvedValue(undefined),
      deleteConnection: vi.fn().mockResolvedValue(undefined),
      clearConnectionRecords: vi.fn().mockResolvedValue(undefined),
      providerConfigKeys: { claude: "test-config-key" },
      connectionIds: { claude: "test-connection-id" },
    },
    ...overrides,
  };
}
```

**Location:** No fixtures directory present; create alongside source or in a `__tests__/` directory.

## Coverage

**Requirements:** None enforced — no coverage threshold configured
**View Coverage:**
```bash
npx vitest --coverage
```

## Test Types

**Unit Tests:**
- Primary test type for this package. The DI pattern in `src/deps.ts` is specifically designed for isolated unit testing of `src/index.ts` functions (settings read/write, model selection, connection status).

**Integration Tests:**
- Not applicable for this connector package — integration with the host app is handled at the host level.

**E2E Tests:**
- Not applicable — no E2E framework configured.

## Common Patterns

**Async Testing:**
```typescript
// Functions like getConfiguredAnthropicConnection are async
it("returns null when no connection is configured", async () => {
  registerAnthropicConnector(makeMockDeps());
  const result = await getConfiguredAnthropicConnection();
  expect(result).toBeNull();
});
```

**Error Testing:**
```typescript
// getAnthropicDeps() throws when deps are not registered
it("throws if deps not registered", () => {
  _resetAnthropicDepsForTests();
  expect(() => getAnthropicDeps()).toThrow(
    "@cinatra-ai/anthropic-connector: host runtime deps not registered"
  );
});
```

## Notes

- Vitest is declared as the test runner (`"test": "vitest"` in `package.json`) but no test files currently exist in `src/`.
- The `_resetAnthropicDepsForTests` export in `src/deps.ts` is the clear signal that the codebase is designed to be tested but tests have not yet been written.
- The `AnthropicConnectorDeps` interface provides a clean, typed seam for all external dependencies, making the core logic in `src/index.ts` straightforward to unit test.

---

*Testing analysis: 2026-06-09*
