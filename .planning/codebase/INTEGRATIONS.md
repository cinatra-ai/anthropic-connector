# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**LLM Provider:**
- Anthropic Claude API — the core integration; provides Claude model inference for Cinatra agents
  - SDK/Client: No direct Anthropic SDK in this package; API key is stored and forwarded by the host
  - Auth: API key credential stored via Nango (`type: "API_KEY"`), connector key `"claude"`
  - Supported models (defined in `src/index.ts`): `claude-opus-4-7`, `claude-opus-4`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

**Connection Management:**
- Nango — OAuth/API-key credential storage and management service
  - Used via host-injected `AnthropicNangoCapability` interface (`src/deps.ts`)
  - Functions: `isConfigured`, `getStatus`, `getFrontendConfig`, `getPrimarySavedConnection`, `getCredentials`, `ensureIntegration`, `importConnection`, `deleteConnection`, `clearConnectionRecords`
  - Provider: `"anthropic"`, provider config key and connection ID supplied by host at boot
  - UI: `NangoManagedApiCard` from `@cinatra-ai/sdk-ui/nango` renders the Nango connect UI in `src/settings-page.tsx`

## Data Storage

**Databases:**
- Host database (abstract) — connector config and Anthropic connection row persisted via host-injected deps:
  - `readConnectorConfigFromDatabase(connectorId, fallback)` — reads `"anthropic"` config key
  - `writeConnectorConfigToDatabase(connectorId, value)` — writes `"anthropic"` config key
  - `readAnthropicConnectionFromDatabase()` — reads legacy DB-stored API key (fallback when Nango is not configured)
  - All three are bound by the host at boot via `registerAnthropicConnector(deps)` (`src/deps.ts`)

**File Storage:**
- Not applicable

**Caching:**
- Anthropic prompt caching — not a caching service, but a feature flag (`promptCachingEnabled`) that sends a cache-control marker on system prompts to Anthropic's API to reduce cost/latency on repeated calls. Configured in `src/index.ts` (`getAnthropicPromptCachingEnabled`, `saveAnthropicPromptCachingEnabled`).

## Authentication & Identity

**Auth Provider:**
- Nango (credential storage layer) — API key for Anthropic is imported into Nango via `importConnection` and retrieved via `getCredentials`; the raw key is never stored long-term in the local database after a successful Nango sync (`src/index.ts` `saveAnthropicAPISettings`)
- Fallback: database-stored API key used when Nango is not configured (`readAnthropicConnectionFromDatabase`)
- Extension action gating: `requireExtensionAction(ANTHROPIC_PACKAGE_ID, "manage")` from `@cinatra-ai/sdk-extensions` protects the `saveAnthropicSettingsAction` server action (`src/actions.ts`)

## Monitoring & Observability

**Error Tracking:**
- Not detected in this package

**Logs:**
- No logging calls detected; errors surface via thrown `Error` instances in server actions and connector functions

## CI/CD & Deployment

**Hosting:**
- Deployed as part of the Cinatra host Next.js application
- Package is a Cinatra connector (`cinatra.kind: "connector"`, `cinatra.apiVersion: "cinatra.ai/v1"` in `package.json`)

**CI Pipeline:**
- `.github/workflows/` directory present; workflow files not read (contents not inspected)

## Environment Configuration

**Required env vars:**
- No env vars read directly by this package; all runtime configuration is injected by the host via `registerAnthropicConnector(deps)` at boot
- Anthropic API key is provided by the workspace admin through the connector settings UI and stored in Nango

**Secrets location:**
- `.npmrc` present — contains package registry config (existence noted only, contents not read for secrets)
- Anthropic API key stored in Nango credential store (managed by host)
- Legacy fallback: API key may exist in host database (`readAnthropicConnectionFromDatabase`)

## Webhooks & Callbacks

**Incoming:**
- Not applicable — this connector has no webhook endpoints

**Outgoing:**
- Not applicable — outgoing calls to Anthropic API are made by the host LLM provider layer, not this connector package directly

## MCP (Model Context Protocol)

- Connector exposes an `mcpMode` setting (`"native"` | `"function-tools"`) that controls how Claude accesses the Cinatra MCP server
- `"function-tools"` (default): broad-compatibility fallback using function-calling
- `"native"`: uses the Anthropic MCP beta path
- Mode is persisted in connector config and retrieved via `getMcpMode()` / `saveMcpMode()` in `src/index.ts`

---

*Integration audit: 2026-06-09*
