# Vercel AI SDK Reference

Features used per phase. Updated only when a phase is confirmed done.

Packages: `ai` (v6), `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`

---

## Provider instantiation — Phase 5

API key passed at provider level (not per-call). Customer key from `ReviewJob.llm_api_key`.

```typescript
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

const model = createAnthropic({ apiKey })('claude-sonnet-4-6')
const model = createOpenAI({ apiKey })('gpt-4o-mini')
const model = createGoogleGenerativeAI({ apiKey })('gemini-2.5-flash')
```

## `generateText()` — Phase 5

Used in all three LLM passes (summary, questions, ask). Returns `{ text, usage }`.

- `usage.inputTokens` — prompt tokens
- `usage.outputTokens` — completion tokens
- `usage.totalTokens` — total (may differ from sum if provider charges differently)

```typescript
const { text, usage } = await generateText({ model, prompt, maxTokens: 512 })
```

## Model IDs — Phase 5

Current real model IDs per provider (as of June 2026):

| Provider | Models |
|---|---|
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` |
| OpenAI | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` |
| Google | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` |

## Mock model for tests — Phase 5

AI SDK v6 requires `specificationVersion: 'v2'` or `'v3'`. Use `v2` for test mocks (works in compat mode). `doGenerate` must return `content: [{ type: 'text', text }]` not a bare `text` field.

```typescript
const mockModel = {
  specificationVersion: 'v2',
  provider: 'mock',
  modelId: 'mock-model',
  supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text', text: responseText }],
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    rawCall: { rawPrompt: '', rawSettings: {} },
  }),
} as unknown as LanguageModel
```
