# Coding Conventions

**Analysis Date:** 2026-06-09

## Naming Patterns

**Files:**
- `kebab-case` for multi-word filenames: `setup-page.tsx`, `settings-page.tsx`
- `camelCase` for single-concept modules: `actions.ts`, `deps.ts`, `index.ts`
- UI components in `src/components/ui/` named after their element: `button.tsx`, `label.tsx`

**Functions:**
- `camelCase` for all exported functions: `getAnthropicDeps`, `saveAnthropicAPISettings`, `registerAnthropicConnector`
- Getter functions prefixed with `get`: `getDefaultClaudeModel`, `getMcpMode`, `getAnthropicDeps`
- Setter/save functions prefixed with `save`: `saveDefaultClaudeModel`, `saveMcpMode`
- Server actions suffixed with `Action`: `saveAnthropicSettingsAction`
- Internal/test-only helpers prefixed with `_`: `_resetAnthropicDepsForTests`

**Variables:**
- `camelCase` for local variables and constants
- `UPPER_SNAKE_CASE` for module-level constants: `CLAUDE_MODELS`, `ANTHROPIC_PACKAGE_ID`, `ANTHROPIC_DEPS_KEY`

**Types and Interfaces:**
- `PascalCase` for all types, interfaces, and exported type aliases: `AnthropicConnectorDeps`, `AnthropicNangoCapability`, `ClaudeModel`, `AnthropicAPISettings`
- Descriptive suffixes: `Deps` for dependency injection types, `Capability` for interface slices, `Row` for database row shapes

**React Components:**
- `PascalCase` for component names: `Button`, `Label`, `AnthropicSettingsContent`, `AnthropicConnectorSetupPage`
- `PascalCase` for component prop types suffixed with `Props`: `ConnectorSetupPageProps`, `SettingsPageProps`

## Code Style

**Formatting:**
- No `.prettierrc` or `.eslintrc` found in this repo — formatting is enforced upstream in the monorepo or at CI level
- Indentation: 2 spaces (observed throughout all source files)
- Trailing commas used in multi-line object/array literals
- Single quotes in `.tsx` UI components (e.g., `label.tsx`), double quotes in `.ts` logic files (e.g., `deps.ts`, `index.ts`)

**Linting:**
- No local ESLint config — relies on monorepo or host toolchain
- TypeScript strict mode enabled (`"strict": true` in `tsconfig.json`)
- `noImplicitAny: false` — exceptions allowed for permissive `unknown` returns in interface definitions

## Import Organization

**Order (observed):**
1. External packages (`react`, `zod`, `class-variance-authority`, `radix-ui`)
2. SDK peer dependencies (`@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`)
3. Internal package imports (`./deps`, `./index`, `./actions`, `./components/ui/button`)

**Path Aliases:**
- No `@/` path alias in this package — all internal imports use relative paths (`./`, `../`)
- The `@/` alias belongs to the host app; its absence here is intentional and enforced by comment in `deps.ts`

**Module Syntax:**
- `verbatimModuleSyntax: true` in tsconfig — `import type` is used for type-only imports (e.g., `import type { HostRequiredPackageDefinition }` in `src/index.ts`)
- ESM-only (`"type": "module"` in `package.json`)

## Error Handling

**Patterns:**
- Throw `new Error(message)` for unrecoverable states (missing deps, missing API key): `src/deps.ts` line 88, `src/index.ts` line 182
- In server actions (`src/actions.ts`), wrap async calls in `try/catch` and re-throw as `new Error(message)` with a user-facing string extracted via `error instanceof Error ? error.message : "fallback"`
- Defensive credential reads: credentials from Nango are typed as `unknown` and checked with `typeof`/`"in"` guards before use (see `src/index.ts` lines 120–121)
- Validation with `zod.parse` (throws on invalid input) in server actions: `src/actions.ts` line 31

## Logging

**Framework:** None — no logging library imported
**Patterns:** No logging calls observed; errors propagate via thrown `Error` instances

## Comments

**When to Comment:**
- File-level block comments explain architectural decisions, constraints, and cross-cutting concerns (why a module is structured a certain way, not what it does line by line)
- Inline comments clarify non-obvious choices: guard conditions, fallback paths, constraint references (`// owner directive 2026-05-20`)
- `@internal` JSDoc tag marks test-only exports: `/** @internal test-only. */` in `src/deps.ts` line 96
- JSDoc used selectively on exported functions and interfaces for IDE discoverability

**TSDoc:**
- `/** ... */` style used for public exports and interface members
- `@internal` used to mark test utilities

## Function Design

**Size:** Functions are small and single-purpose; no function exceeds ~30 lines
**Parameters:** Prefer typed object parameters for settings/input shapes; primitive parameters for simple getters/setters
**Return Values:** Typed with `satisfies` for narrowing (e.g., `return { ... } satisfies AnthropicAPISettings`); async functions return `Promise<T | null>` where the connection may be absent

## Module Design

**Exports:** All public API exported from `src/index.ts`; `src/deps.ts` exports the DI registration surface; `src/actions.ts` is a server-actions-only module with `"use server"` directive
**Barrel Files:** `src/index.ts` acts as the package barrel — re-exports from `./deps` and defines the connector's public types and functions
**Dependency Injection:** Uses `globalThis` symbol anchoring for cross-bundle dep resolution (see `src/deps.ts`); avoids direct host imports (`@/`)

## React Component Conventions

**Directives:**
- `"use server"` at top of `src/actions.ts`
- `"use client"` at top of `src/components/ui/label.tsx`
- Server components (no directive) for page-level components: `src/setup-page.tsx`, `src/settings-page.tsx`

**Styling:**
- Tailwind CSS utility classes throughout
- Component variants defined with `class-variance-authority` (`cva`): `src/components/ui/button.tsx`
- `cn()` helper from `@cinatra-ai/sdk-ui/lib/utils` for conditional class merging
- `data-slot` attribute added to component roots for CSS targeting: `data-slot="button"`, `data-slot="label"`

---

*Convention analysis: 2026-06-09*
