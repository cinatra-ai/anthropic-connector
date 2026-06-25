# Anthropic

Connect your Anthropic account so Cinatra agents can run on Claude. Once you bring your API key, any agent pinned to a Claude model becomes runnable, and you can choose the default Claude variant the workspace falls back to when an agent does not name one explicitly.

## Works with

- Cinatra (connector kind: `connector`)

## Capabilities

- Run Cinatra agents on Claude
- Choose the default Claude model used across the workspace
- Let Claude reach Cinatra's tools through native MCP or a function-tools fallback
- Cut token cost on long, repeated prompts with prompt caching

---

## Purpose

The Anthropic connector bridges Cinatra's agent runtime and the Anthropic Claude API. It stores your API credential through the workspace connection service (Nango), exposes a settings page where you pick the default model and MCP mode, and registers the `llm-provider-surface` capability that the Cinatra host uses to dispatch LLM requests.

There are two credential paths the connector checks at runtime:

- **Managed (primary):** the API key is retrieved from the workspace connection service (Nango). Setting up the connector stores the key there; nothing is kept locally after a successful save.
- **Database fallback:** if Nango is not configured or returns no credentials, the connector falls back to an API key stored directly in the workspace database.

## Install

This connector is a first-party Cinatra extension and is not published to npm separately. It ships as part of the Cinatra platform and is activated through the Cinatra extension registry — no manual `npm install` is needed.

If you are working in the connector's source tree, install dependencies with:

```bash
npm install
```

## Configuration

Open **Settings → Connectors → Anthropic** (or navigate to `/connectors/cinatra-ai/anthropic-connector/setup`) to configure the connector.

### Required: API key

1. Obtain an API key from your Anthropic account dashboard.
2. Paste it into the **Anthropic API** card on the setup page and click **Connect**.
3. The key is forwarded to the workspace connection service. After the first successful save the key is no longer stored locally; it is held by the connection service.

> **Prerequisite:** the workspace connection service (Nango) must be configured before you can save an API key. If it is not configured, the setup page shows a warning and a link to the connection settings page.

### Default Claude model

Choose which Claude model the workspace falls back to when an agent definition does not specify one. Available models are listed in the **Default Claude model** selector on the settings page. The workspace default differs between development and production environments — development defaults to Haiku and production defaults to Sonnet.

### MCP mode

Controls how Claude accesses Cinatra's tool surface:

| Value | Behaviour |
|---|---|
| `function-tools` (default) | Tools are passed as Anthropic function-tool definitions — broadest compatibility. |
| `native` | Uses the Anthropic native MCP beta path. |

Change this on the settings page under **MCP mode**.

### Prompt caching

When enabled, the system prompt is sent with a cache control marker so Anthropic can cache it between calls, reducing cost and latency for repeated requests. Toggle this under **Prompt caching** on the settings page.

## Usage example

A workspace agent configured with `model: claude-sonnet-4-6` will use the Anthropic connector to execute its LLM calls. At runtime the host resolves the connector's `llm-provider-surface` capability to:

1. Retrieve the stored API key from the connection service.
2. Forward the agent prompt to the Anthropic API using the configured model.
3. Return the response and any tool calls back to the agent runtime.

If the API key is missing or the connection service is not reachable, the connector returns `null` from `getConfiguredAnthropicConnection()`. The connector settings card then shows "Setup required".

### Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Connector card shows "Setup required" | No API key saved, or connection service not configured | Complete setup on the Anthropic connector page |
| "Nango is not connected" warning on the setup page | Connection service credentials not set in workspace | Open connection settings and configure Nango |
| `host service "…" is not registered` error in logs | Connector activated before the host finished boot wiring | Check the host extension activation order |
| Saving the API key throws "Configure the connection service first…" | Connection service not configured | Set up Nango before saving an Anthropic API key |

## API contract

The connector registers one capability on the host capability registry:

**`llm-provider-surface`** — consumed by the Cinatra host to dispatch LLM calls. The surface exposes:

| Method | Description |
|---|---|
| `getConfiguredConnection()` | Returns `{ apiKey, defaultModel, mcpMode, promptCachingEnabled }` or `null` if not configured. |
| `getDefaultModel()` | Returns the currently configured default Claude model ID. |
| `saveDefaultModel(model)` | Persists a new default model selection. |
| `saveAPISettings({ apiKey })` | Saves the API key through the connection service. |
| `clearAPISettings()` | Removes the stored connection and clears all saved credentials. |
| `models` | Read-only list of selectable Claude model IDs. |

Settings are persisted per-workspace under the connector ID `anthropic` in the workspace configuration store.

## Development

### Prerequisites

- Node.js (version consistent with the repo's `package.json` engines field)
- The Cinatra monorepo checked out (peer dependencies `@cinatra-ai/sdk-extensions` and `@cinatra-ai/sdk-ui` are resolved from the workspace)

### Run tests

```bash
npm test
```

Tests live in `src/__tests__/`. The test suite uses Vitest and stubs the host service dependencies through the `registerAnthropicConnector(deps)` hook, so no live Anthropic credentials or network access are needed to run them.

### Lint

```bash
npm run lint
```

### Package layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Exported settings helpers, type definitions, and `CLAUDE_MODELS` list |
| `src/register.ts` | Connector server entry — binds host deps and registers `llm-provider-surface` |
| `src/deps.ts` | Dependency injection types and the global deps slot |
| `src/actions.ts` | Server actions for the settings form (API key, default model) |
| `src/settings-page.tsx` | Shared settings UI component (used by setup page and host modal) |
| `src/setup-page.tsx` | Standalone setup page wrapper rendered at the connector setup route |

### Adding a Claude model

Update the `CLAUDE_MODELS` array in `src/index.ts`. The model must also be present in the host's LLM provider policy allow-list (`ALLOWED_MODEL_IDS.anthropic`) before agents can reference it in their definitions.

## Troubleshooting

**The setup page shows "Nango is not connected".**
The workspace connection service must be configured before you can save an API key. Go to **Settings → Environment → Connections** and configure Nango, then return to the Anthropic connector page.

**Saving the API key fails with "Configure the connection service first".**
Same root cause as above: the connection service is not set up. Configure Nango first.

**Agents fail with a missing-credential error at runtime.**
Run through the setup page to confirm the Anthropic API card shows "Connected". If Nango is configured but the connector still shows "Setup required", the connection record may have been cleared — re-enter the API key.

**The connector settings show "incomplete" status.**
This appears when an API key is present in local settings but no Nango connection record exists. Open the setup page and save the key through the connection service to complete the connection.

**`host service "…" is not registered` appears in server logs.**
The connector's `register(ctx)` executed before the host finished wiring its required services. Verify that the host extension activation order runs `register-host-connector-services` before activating this connector.
