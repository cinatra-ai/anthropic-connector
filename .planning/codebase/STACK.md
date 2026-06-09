# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript (strict mode) — all source files in `src/` (`.ts`, `.tsx`)

**Secondary:**
- TSX (React JSX) — UI components and page components in `src/components/`, `src/settings-page.tsx`, `src/setup-page.tsx`

## Runtime

**Environment:**
- Node.js (ESM-only package — `"type": "module"` in `package.json`)
- Target: ES2023 (`tsconfig.json` `target`)

**Package Manager:**
- npm (`.npmrc` present with `auto-install-peers=false`)
- Lockfile: Not detected in repo root (likely managed by parent workspace or CI)

## Frameworks

**Core:**
- React 19 (peer dependency `^19.2.3`) — UI rendering for connector settings and setup pages
- React DOM 19 (peer dependency `^19.2.3`) — DOM bindings

**Testing:**
- Vitest — test runner (`"test": "vitest"` in `package.json`)

**Build/Dev:**
- TypeScript compiler — configured via `tsconfig.json`, outputs to `dist/`, generates `.d.ts` and sourcemaps

## Key Dependencies

**Critical:**
- `zod` `^4.4.3` — schema validation for form data in `src/actions.ts` (server action input parsing)
- `class-variance-authority` `^0.7.1` — variant-based class composition for UI components (`src/components/ui/button.tsx`)
- `clsx` `^2.1.1` — conditional class merging for UI components
- `tailwind-merge` `^3.5.0` — Tailwind CSS class deduplication for UI components
- `radix-ui` `^1.4.3` — headless UI primitives (label component in `src/components/ui/label.tsx`)

**Peer (host-provided):**
- `@cinatra-ai/sdk-extensions` — extension action gating (`requireExtensionAction`), `HostRequiredPackageDefinition` type; used in `src/actions.ts` and `src/index.ts`
- `@cinatra-ai/sdk-ui` — `NangoManagedApiCard` UI component; used in `src/settings-page.tsx`

## Configuration

**Environment:**
- No `.env` file read directly by this package; credentials are injected at runtime via host dependency injection (`registerAnthropicConnector(deps)` in `src/deps.ts`)
- Anthropic API key is stored/retrieved through host-bound `nango` and `readAnthropicConnectionFromDatabase` deps

**Build:**
- `tsconfig.json` — standalone strict config, ESNext modules, bundler resolution, JSX via `react-jsx`, outputs to `dist/`
- `.npmrc` — `auto-install-peers=false`

## Platform Requirements

**Development:**
- Node.js with ESM support
- Host must call `registerAnthropicConnector(deps)` at boot before any connector functions are used

**Production:**
- Deployed as part of the Cinatra host application (Next.js)
- Connector is a Cinatra `kind: connector` package (`package.json` `cinatra` field)
- Server actions (`src/actions.ts`) require a Next.js App Router environment (`"use server"` directive)
- Cinatra platform API version: `cinatra.ai/v1`

---

*Stack analysis: 2026-06-09*
