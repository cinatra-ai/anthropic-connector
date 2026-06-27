import { saveAnthropicSettingsAction } from "./actions";
import { NangoManagedApiCard } from "@cinatra-ai/sdk-ui/nango";
import { getAnthropicDeps } from "./deps";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Link } from "./components/ui/link";
import { Select } from "./components/ui/select";
import {
  isAnthropicConnectionReady,
  getConfiguredAnthropicConnection,
  getDefaultClaudeModel,
  CLAUDE_MODELS,
  getMcpMode,
  getAnthropicPromptCachingEnabled,
} from "./index";

type SettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Shared Anthropic settings content (no shell). Rendered inside the page shell by
 * the connector setup route (`setup-page.tsx`) AND inside `<ConnectorSettingsDialog>`
 * by the host `/configuration/llm?modal=anthropic` overlay (apis-page.tsx wraps it,
 * mirroring the openai modal). Owner directive 2026-05-20: the connector setup route
 * must be a page, not a modal.
 *
 * SDK-only — Nango status/config + the connection card come
 * through the host-injected deps slot (`getAnthropicDeps().nango.*`) + the sdk-ui
 * NangoManagedApiCard; no `@cinatra-ai/nango-connector` or `@/` imports.
 */
export async function AnthropicSettingsContent({ searchParams }: SettingsPageProps) {
  const deps = getAnthropicDeps();
  const resolvedSearchParams: Record<string, string | string[] | undefined> =
    await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));

  const configuredConnection = await getConfiguredAnthropicConnection();
  const isConnected = isAnthropicConnectionReady(configuredConnection);
  const nangoStatus = deps.nango.getStatus();
  const nangoFrontendConfig = deps.nango.getFrontendConfig();
  const connectionServiceReady = nangoStatus.status === "connected";
  const errorMessage = pickSearchParam(resolvedSearchParams.error);
  const saved = pickSearchParam(resolvedSearchParams.saved) === "1";
  const currentDefaultModel = getDefaultClaudeModel();
  const currentMcpMode = getMcpMode();
  const currentPromptCachingEnabled = getAnthropicPromptCachingEnabled();

  return (
    <div className="flex flex-col gap-6">
      {nangoStatus.status !== "connected" ? (
        <div className="soft-panel rounded-control px-4 py-4">
          <p className="text-sm font-medium text-foreground">Nango is not connected</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect Nango to manage the Anthropic API credential. Configure it on the connections settings page.
          </p>
          <Button asChild variant="outline" className="mt-3">
            <Link href="/configuration/environment?tab=connections">Open connection settings</Link>
          </Button>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      {saved ? (
        <div className="rounded-control border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          The Anthropic API settings were saved.
        </div>
      ) : null}

      <NangoManagedApiCard
        connectorKey="claude"
        title="Anthropic API"
        description="Connect Anthropic's Claude API for LLM-powered workflows."
        badge={isConnected ? "Connected" : "Setup required"}
        isConnected={isConnected}
        usesConnectUI={true}
        reconnectConnectionId={deps.nango.getPrimarySavedConnection("claude")?.connectionId}
        nangoFrontendConfig={nangoFrontendConfig}
        connectionServiceReady={connectionServiceReady}
      />

      <form action={saveAnthropicSettingsAction}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-semibold">Default Claude model</Label>
              <p className="mt-1 text-sm text-muted-foreground">
                Select which Claude model is used by default for Anthropic-powered workflows.
              </p>
            </div>
            <Select name="defaultModel" defaultValue={currentDefaultModel}>
              {CLAUDE_MODELS.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </Select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-semibold">MCP mode</Label>
              <p className="mt-1 text-sm text-muted-foreground">
                How Claude accesses the Cinatra MCP server. Use function-tools (default) for broad compatibility. Use native for the Anthropic MCP beta path.
              </p>
            </div>
            <Select name="mcpMode" defaultValue={currentMcpMode}>
              <option value="native">native</option>
              <option value="function-tools">function-tools</option>
            </Select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-semibold">Prompt caching</Label>
              <p className="mt-1 text-sm text-muted-foreground">
                When enabled, the system prompt is sent with a cache control marker so Anthropic can cache it between calls — reducing cost and latency for repeated requests.
              </p>
            </div>
            <Select
              name="promptCachingEnabled"
              defaultValue={currentPromptCachingEnabled ? "on" : "off"}
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </Select>
          </div>

          <div className="flex justify-end">
            <Button type="submit">Save</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
