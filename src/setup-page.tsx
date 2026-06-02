// Dispatch-route entry for the Anthropic API connector setup page. The setup
// route must be a page, not a modal (owner directive 2026-05-20). Renders the
// shared `AnthropicSettingsContent` inside the connector's OWN page shell — no
// `@/components/*` host imports (SDK-only, mirrors the openai
// connector's self-contained `<main>` wrapper).

import { AnthropicSettingsContent } from "./settings-page";

type ConnectorSetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
};

export default async function AnthropicConnectorSetupPage({
  searchParams,
}: ConnectorSetupPageProps) {
  return (
    <main className="min-h-screen px-5 py-8 sm:px-8 lg:px-6 lg:py-6">
      <div className="mx-auto w-full max-w-5xl">
        <AnthropicSettingsContent searchParams={Promise.resolve(searchParams)} />
      </div>
    </main>
  );
}
