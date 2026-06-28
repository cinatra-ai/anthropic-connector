# Anthropic

Connect your Anthropic account so Cinatra agents can run on Claude. Once you bring your API key, any agent pinned to a Claude model becomes runnable, and you can choose the default Claude variant the workspace falls back to when an agent does not name one explicitly. Full documentation lives in the Integrations hub at https://docs.cinatra.ai/integrations/anthropic/

## Works with

- Cinatra (connector kind: `connector`)

## Capabilities

- Run Cinatra agents on Claude models (Haiku, Sonnet, Opus)
- Choose the default Claude model used across the workspace
- Let Claude reach Cinatra's tools through native MCP or a function-tools fallback
- Cut token cost on long, repeated prompts with prompt caching
