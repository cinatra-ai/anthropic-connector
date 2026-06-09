# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
anthropic-connector/
├── src/
│   ├── index.ts              # Public package API — types, settings functions, manifest
│   ├── deps.ts               # Dependency injection layer (globalThis slot)
│   ├── actions.ts            # Next.js server actions ("use server")
│   ├── settings-page.tsx     # Shared async RSC — settings form content
│   ├── setup-page.tsx        # Page shell for /connectors/.../setup route
│   └── components/
│       └── ui/
│           ├── button.tsx    # CVA + Radix Slot Button primitive
│           └── label.tsx     # Label primitive
├── .github/
│   └── workflows/
│       ├── ci.yml            # CI pipeline
│       └── release.yml       # Release pipeline
├── .planning/
│   └── codebase/             # GSD analysis documents
├── package.json              # Cinatra connector manifest + deps
├── tsconfig.json             # TypeScript config
├── .npmrc                    # npm registry config
├── LICENSE                   # Apache-2.0
└── README.md                 # Package documentation
```

## Directory Purposes

**`src/`:**
- Purpose: All package source code
- Contains: TypeScript/TSX modules — business logic, DI layer, UI components, server actions
- Key files: `src/index.ts` (public API), `src/deps.ts` (DI layer)

**`src/components/ui/`:**
- Purpose: Local UI primitives used by settings UI
- Contains: `button.tsx`, `label.tsx` — shadcn-style CVA components
- Note: These mirror host UI primitives but are co-located in the connector to keep it SDK-only (no `@/components/` host imports)

**`.github/workflows/`:**
- Purpose: CI/CD automation
- Contains: `ci.yml` (tests/lint), `release.yml` (publish)

**`.planning/codebase/`:**
- Purpose: GSD architecture analysis documents
- Generated: Yes (by gsd-map-codebase)
- Committed: Yes

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main package entry — all exported types, functions, and the connector manifest object
- `src/deps.ts`: DI registrar — `registerAnthropicConnector` re-exported from `src/index.ts`
- `src/setup-page.tsx`: Default export consumed by host Next.js routing for the setup page

**Configuration:**
- `package.json`: Connector manifest in `"cinatra"` field; peer deps (`@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`, React 19); `"main"` and `"types"` both point to `src/index.ts`
- `tsconfig.json`: TypeScript project config
- `.npmrc`: Registry/auth config (note existence only — not read)

**Core Logic:**
- `src/index.ts`: `getConfiguredAnthropicConnection`, `saveAnthropicAPISettings`, `clearAnthropicAPISettings`, `getDefaultClaudeModel`, `getMcpMode`, `getAnthropicPromptCachingEnabled`, `getAnthropicAPIStatus`
- `src/deps.ts`: `AnthropicConnectorDeps`, `AnthropicNangoCapability`, `registerAnthropicConnector`, `getAnthropicDeps`

**UI:**
- `src/settings-page.tsx`: `AnthropicSettingsContent` — shared between page and modal contexts
- `src/setup-page.tsx`: `AnthropicConnectorSetupPage` — default export page shell

**Server Actions:**
- `src/actions.ts`: `saveAnthropicSettingsAction` — gated by `requireExtensionAction`

**Testing:**
- `vitest` configured via `package.json` `"scripts": { "test": "vitest" }` — no vitest config file detected at repo root; test files not present in this package

## Naming Conventions

**Files:**
- kebab-case for multi-word files: `settings-page.tsx`, `setup-page.tsx`
- Single-word files use no separator: `actions.ts`, `deps.ts`, `index.ts`
- UI primitives match shadcn convention: `button.tsx`, `label.tsx`

**Directories:**
- lowercase kebab-case: `components/ui/`

**Exports:**
- Functions: camelCase (`getAnthropicDeps`, `saveAnthropicAPISettings`)
- Types/Interfaces: PascalCase (`AnthropicConnectorDeps`, `AnthropicAPISettings`, `ClaudeModel`)
- Constants: SCREAMING_SNAKE_CASE (`CLAUDE_MODELS`, `ANTHROPIC_PACKAGE_ID`)
- React components: PascalCase (`AnthropicSettingsContent`, `Button`, `Label`)

## Where to Add New Code

**New connector setting (e.g., a new preference field):**
- Add field to `AnthropicAPISettings` in `src/index.ts`
- Add getter function (e.g., `getNewSetting()`) and setter (e.g., `saveNewSetting()`) in `src/index.ts`
- Expose in `getConfiguredAnthropicConnection` return if consumed by the LLM provider
- Add form control to `AnthropicSettingsContent` in `src/settings-page.tsx`
- Add field to `anthropicSettingsSchema` and handle in `saveAnthropicSettingsAction` in `src/actions.ts`

**New host capability needed by the connector:**
- Add method signature to `AnthropicConnectorDeps` or `AnthropicNangoCapability` in `src/deps.ts`
- The host must then provide the implementation in its `registerAnthropicConnector(deps)` call

**New UI component:**
- Add to `src/components/ui/` following the CVA + Radix Slot pattern used by `src/components/ui/button.tsx`
- Import utilities from `@cinatra-ai/sdk-ui/lib/utils` (the `cn` helper)

**New server action:**
- Add to `src/actions.ts` with `"use server"` at top of file
- Always gate with `await requireExtensionAction(ANTHROPIC_PACKAGE_ID, "manage")` before any mutation

**Tests:**
- No existing test files in this package; add alongside source or in a `__tests__/` directory under `src/`
- Use `_resetAnthropicDepsForTests()` from `src/deps.ts` in test teardown to clear the globalThis slot

## Special Directories

**`.planning/`:**
- Purpose: GSD planning and architecture documents
- Generated: Yes
- Committed: Yes

**`src/components/ui/`:**
- Purpose: Self-contained UI primitives that mirror the host's shadcn component library
- Generated: No (manually maintained)
- Note: Must remain SDK-only — import only from `@cinatra-ai/sdk-ui`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`

---

*Structure analysis: 2026-06-09*
