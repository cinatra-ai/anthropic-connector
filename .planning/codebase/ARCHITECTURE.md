<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌────────────────────────────────────────────────────────────────┐
│                    Host (Next.js App)                          │
│   /connectors/cinatra-ai/anthropic-connector/setup route       │
│   /configuration/llm?modal=anthropic overlay                   │
└────────────┬───────────────────────────────────────────────────┘
             │ registers deps at boot
             ▼
┌────────────────────────────────────────────────────────────────┐
│              Dependency Injection Layer                        │
│          `src/deps.ts`  (globalThis Symbol slot)               │
│  registerAnthropicConnector(deps) / getAnthropicDeps()         │
└────────────┬───────────────────────────────────────────────────┘
             │
      ┌──────┴───────────┐
      ▼                  ▼
┌──────────────┐  ┌──────────────────────────────────────────────┐
│  Core Logic  │  │             UI Layer                         │
│ `src/index.ts`│  │ `src/settings-page.tsx`  (async RSC)         │
│ - Settings   │  │ `src/setup-page.tsx`     (page shell)         │
│ - Nango sync │  │ `src/actions.ts`         (server actions)     │
│ - Model mgmt │  │ `src/components/ui/`     (button, label)      │
└──────┬───────┘  └──────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────┐
│  External Storage / Services                                   │
│  - Nango (credential vault — via AnthropicNangoCapability)     │
│  - Host DB (connector_config row — via deps callbacks)         │
│  - Host DB (anthropic connection row — fallback credential)    │
└────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `registerAnthropicConnector` | Boot-time deps wiring via versioned globalThis Symbol | `src/deps.ts` |
| `getAnthropicDeps` | Runtime deps resolver (throws if not registered) | `src/deps.ts` |
| `AnthropicConnectorDeps` | Interface contract between connector and host | `src/deps.ts` |
| `AnthropicNangoCapability` | Typed Nango surface scoped to "claude" connector key | `src/deps.ts` |
| Core settings functions | Read/write API key, default model, MCP mode, prompt caching | `src/index.ts` |
| `getConfiguredAnthropicConnection` | Credential resolution: Nango first, DB fallback | `src/index.ts` |
| `saveAnthropicAPISettings` | Syncs API key to Nango, clears from DB | `src/index.ts` |
| `AnthropicSettingsContent` | Shared async RSC for settings form (page + modal) | `src/settings-page.tsx` |
| `AnthropicConnectorSetupPage` | Page shell wrapping `AnthropicSettingsContent` | `src/setup-page.tsx` |
| `saveAnthropicSettingsAction` | Gated server action for form submission | `src/actions.ts` |
| `Button`, `Label` | Local UI primitives (CVA + Radix Slot) | `src/components/ui/` |
| `anthropicAPIConnectionPackage` | Connector manifest for host package registry | `src/index.ts` |
| `CLAUDE_MODELS` | Allowlist of selectable Claude model IDs | `src/index.ts` |

## Pattern Overview

**Overall:** Dependency-injection connector pattern — the package exposes only SDK-gated logic; all host internals (DB, Nango, runtime mode) are injected at boot via a versioned `globalThis` Symbol slot.

**Key Characteristics:**
- No `@/` (host-internal) imports anywhere in the package; strictly SDK-only (`@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`)
- Host registers concrete impls once at boot via `registerAnthropicConnector(deps)`; all runtime callsites resolve via `getAnthropicDeps()`
- The Symbol is versioned (`/v1`) and namespace-anchored (`@cinatra-ai/anthropic-connector:host-deps/v1`) so separately-compiled Next.js bundles resolve the same slot
- Server actions are co-located in the package and gated by `requireExtensionAction(packageId, "manage")`
- UI renders as async React Server Components; credential read happens server-side at render time

## Layers

**Dependency Injection Layer:**
- Purpose: Decouples connector from host internals; provides stable boot-time registration and runtime resolution
- Location: `src/deps.ts`
- Contains: `AnthropicConnectorDeps` interface, `AnthropicNangoCapability` interface, `registerAnthropicConnector`, `getAnthropicDeps`, `_resetAnthropicDepsForTests`
- Depends on: nothing (leaf module)
- Used by: all other src modules

**Core Business Logic Layer:**
- Purpose: Settings CRUD, credential resolution, connection status, model/MCP/caching preference management
- Location: `src/index.ts`
- Contains: `AnthropicAPISettings` type, `CLAUDE_MODELS` const, all exported functions
- Depends on: `src/deps.ts`
- Used by: `src/actions.ts`, `src/settings-page.tsx`, host LLM provider

**Server Actions Layer:**
- Purpose: Next.js "use server" form handlers, access-gated by `requireExtensionAction`
- Location: `src/actions.ts`
- Contains: `saveAnthropicSettingsAction`
- Depends on: `src/index.ts`, `@cinatra-ai/sdk-extensions`
- Used by: `src/settings-page.tsx` (form action)

**UI Layer:**
- Purpose: React Server Components for connector administration UI
- Location: `src/settings-page.tsx`, `src/setup-page.tsx`, `src/components/ui/`
- Contains: `AnthropicSettingsContent` (shared RSC), `AnthropicConnectorSetupPage` (page shell), `Button`, `Label`
- Depends on: `src/deps.ts`, `src/index.ts`, `src/actions.ts`, `@cinatra-ai/sdk-ui`
- Used by: host Next.js routing (imported by the `/connectors/…/setup` and `/configuration/llm` routes)

## Data Flow

### Settings Save (API Key)

1. User submits form in `AnthropicSettingsContent` (`src/settings-page.tsx`) via `action={saveAnthropicSettingsAction}`
2. `saveAnthropicSettingsAction` (`src/actions.ts`) checks `requireExtensionAction` permission, validates `FormData` with Zod schema
3. Calls `saveAnthropicAPISettings({ apiKey })` in `src/index.ts`
4. `saveAnthropicAPISettings` calls `deps.nango.ensureIntegration(...)` then `deps.nango.importConnection(...)` to store credential in Nango
5. Clears `apiKey` from DB config row; writes `lastSavedAt` timestamp via `deps.writeConnectorConfigToDatabase`

### Credential Resolution (at request time)

1. Caller invokes `getConfiguredAnthropicConnection()` (`src/index.ts`)
2. Checks `deps.nango.isConfigured()` — if yes, reads from `deps.nango.getPrimarySavedConnection("claude")` then `deps.nango.getCredentials(...)`
3. Falls back to `deps.readAnthropicConnectionFromDatabase()` if Nango is not configured or returns no credentials
4. Returns `{ apiKey, defaultModel, mcpMode, promptCachingEnabled }` or `null`

### Settings Page Render

1. Host routes to `/connectors/cinatra-ai/anthropic-connector/setup`
2. `AnthropicConnectorSetupPage` (`src/setup-page.tsx`) renders `AnthropicSettingsContent` inside a `<main>` shell
3. `AnthropicSettingsContent` (`src/settings-page.tsx`) server-renders by calling `getAnthropicDeps().nango.*` and core index functions
4. Renders `NangoManagedApiCard` from `@cinatra-ai/sdk-ui/nango` plus a settings form

**State Management:**
- Settings persisted in host DB via `deps.readConnectorConfigFromDatabase` / `deps.writeConnectorConfigToDatabase` (keyed by `"anthropic"`)
- Credentials stored in Nango (primary) or DB anthropic connection row (fallback)
- No client-side state; all reads are server-side at RSC render time

## Key Abstractions

**`AnthropicConnectorDeps` interface:**
- Purpose: Contract for everything the connector needs from the host — DB access, runtime mode, Nango surface
- Examples: `src/deps.ts` (definition), host `src/lib/register-transport-connectors.ts` (binding)
- Pattern: Structural interface injected via versioned `globalThis` Symbol — same mechanism as openai/gemini/apify connectors

**`AnthropicNangoCapability` interface:**
- Purpose: Typed subset of the Nango connector surface scoped strictly to the `"claude"` connector key — prevents type-unsafe cross-connector key access
- Examples: `src/deps.ts`
- Pattern: Inline structural interface (not imported from `@cinatra-ai/nango-connector`) to keep zero non-SDK `@cinatra-ai/*` compile-time dependencies

**`CLAUDE_MODELS` tuple:**
- Purpose: Authoritative UI-layer allowlist of selectable model IDs; must stay in sync with `ALLOWED_MODEL_IDS.anthropic` in the host's LLM provider policy validator
- Examples: `src/index.ts` lines 25–31
- Pattern: `as const` tuple with derived `ClaudeModel` type

## Entry Points

**Package index:**
- Location: `src/index.ts`
- Triggers: Imported by host LLM provider, host routing pages, `src/actions.ts`, `src/settings-page.tsx`
- Responsibilities: Exports all public API — types, model list, settings functions, manifest object, connection helpers

**Deps registrar:**
- Location: `src/deps.ts` (re-exported from `src/index.ts` as `registerAnthropicConnector`)
- Triggers: Called once at host boot by `src/lib/register-transport-connectors.ts`
- Responsibilities: Wires concrete host implementations into the versioned globalThis slot

**Setup page default export:**
- Location: `src/setup-page.tsx`
- Triggers: Imported by the host Next.js `/connectors/cinatra-ai/anthropic-connector/setup` route
- Responsibilities: Page shell wrapping the shared settings RSC

**Server action:**
- Location: `src/actions.ts`
- Triggers: Next.js form `action=` attribute in `AnthropicSettingsContent`
- Responsibilities: Validates form data, gates on extension permission, delegates to core functions

## Architectural Constraints

- **Global state:** One module-level singleton — the `AnthropicConnectorDeps` slot anchored on `globalThis` via `Symbol.for(...)` in `src/deps.ts` (line 73). This is intentional for cross-bundle resolution.
- **No host imports:** The package must never import `@/` paths. All host capabilities must go through the `AnthropicConnectorDeps` interface.
- **Circular imports:** None detected. `src/deps.ts` is a leaf with no imports from this package. `src/index.ts` imports only `src/deps.ts`. `src/actions.ts` imports `src/index.ts`. `src/settings-page.tsx` imports all three.
- **ESM-only:** `"type": "module"` in `package.json` — no CommonJS interop. The `/deps` subpath is safe to import directly from tests; the index re-exports it to avoid subpath resolution issues in some Next.js bundle contexts.
- **Server components only:** All UI components are async RSC or server actions; no client components (`"use client"`) in this package.

## Anti-Patterns

### Importing host internals directly

**What happens:** A connector file imports `@/lib/database`, `@/lib/nango`, or any other host-internal module directly.
**Why it's wrong:** Breaks the isolation boundary — the connector becomes coupled to the host's internal module graph, causing bundler errors in standalone contexts (packages/agents vitest, external installs) and preventing the access-gating pattern.
**Do this instead:** Add the required capability to `AnthropicConnectorDeps` in `src/deps.ts` and access it via `getAnthropicDeps()` at the call site.

### Writing settings that discard existing fields

**What happens:** Calling `writeSettings({ apiKey, lastSavedAt })` without spreading `readSettings()` first.
**Why it's wrong:** Overwrites `defaultModel`, `mcpMode`, and `promptCachingEnabled` with `undefined`.
**Do this instead:** Always spread the current settings before writing: `writeSettings({ ...readSettings(), ...updates })` — as done in `saveAnthropicAPISettings` (`src/index.ts` line 209).

## Error Handling

**Strategy:** Throw `Error` with user-facing messages; callers (actions, host) catch and surface them.

**Patterns:**
- `getAnthropicDeps()` throws with a clear boot-registration message if deps are missing (`src/deps.ts` lines 87–93)
- `saveAnthropicAPISettings` throws `"Enter an Anthropic API key to continue."` for missing key and `"Configure the connection service first…"` for unconfigured Nango (`src/index.ts` lines 182–187)
- `saveAnthropicSettingsAction` catches and re-throws with `error.message` for the form layer (`src/actions.ts` lines 44–48)

## Cross-Cutting Concerns

**Logging:** Not implemented in this package; host is responsible for request/error logging.
**Validation:** Zod schema (`anthropicSettingsSchema`) in `src/actions.ts` validates server action input. Credential presence checked via `isAnthropicConnectionReady`.
**Authentication:** `requireExtensionAction(ANTHROPIC_PACKAGE_ID, "manage")` from `@cinatra-ai/sdk-extensions` gates all mutating server actions.

---

*Architecture analysis: 2026-06-09*
