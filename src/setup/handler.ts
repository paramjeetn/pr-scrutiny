import type { Context } from 'hono'
import type { LLMProvider } from '../types/index.js'
import { PROVIDER_MODELS } from '../types/index.js'
import { getInstallation, setInstallation } from '../storage/installations.js'
import { renderSetupPage } from './page.js'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

// ─── Key format validation ────────────────────────────────────────────────────

const KEY_PREFIXES: Record<LLMProvider, string> = {
  anthropic: 'sk-ant-',
  openai:    'sk-',
  google:    'AIza',
}

function validateKeyFormat(provider: LLMProvider, key: string): string | null {
  const prefix = KEY_PREFIXES[provider]
  if (!key.startsWith(prefix)) {
    return `${provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : 'Google'} API keys must start with "${prefix}"`
  }
  if (key.length < 20) return 'API key is too short'
  return null
}

// ─── Live key test (cheap call) ───────────────────────────────────────────────

async function testApiKey(provider: LLMProvider, model: string, apiKey: string): Promise<string | null> {
  try {
    let languageModel
    if (provider === 'anthropic') {
      languageModel = createAnthropic({ apiKey })(model)
    } else if (provider === 'openai') {
      languageModel = createOpenAI({ apiKey })(model)
    } else {
      languageModel = createGoogleGenerativeAI({ apiKey })(model)
    }

    await generateText({
      model: languageModel,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 16,
    })
    return null  // success
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('401') || msg.includes('invalid') || msg.includes('Incorrect API key') || msg.includes('API key not valid')) {
      return 'API key is invalid — check that you copied it correctly'
    }
    if (msg.includes('429') || msg.includes('quota') || msg.includes('rate')) {
      return 'API key valid but quota exceeded — wait a moment then try again'
    }
    // Unknown error — don't block save for infra issues
    console.warn('[setup] key test non-auth error:', msg)
    return null
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleSetupGet(c: Context): Promise<Response> {
  const installationId = Number(c.req.query('installation_id') ?? 0)
  if (!installationId) return c.text('Missing installation_id', 400)

  const existing = await getInstallation(installationId).catch(() => null)
  return c.html(renderSetupPage({ installationId, existing }))
}

export async function handleSetupPost(c: Context): Promise<Response> {
  const form = await c.req.formData()

  const installationId = Number(form.get('installation_id') ?? 0)
  const provider       = (form.get('provider')  as LLMProvider) ?? 'openai'
  const model          = (form.get('model')      as string)      ?? ''
  const apiKeyRaw      = (form.get('api_key')    as string)      ?? ''
  const email          = (form.get('email')      as string)      ?? ''

  if (!installationId) return c.text('Missing installation_id', 400)

  const existing = await getInstallation(installationId).catch(() => null)

  // Validate provider
  if (!['anthropic', 'openai', 'google'].includes(provider)) {
    return c.html(renderSetupPage({ installationId, existing, error: 'Invalid provider' }))
  }

  // Validate model
  if (!PROVIDER_MODELS[provider].includes(model)) {
    return c.html(renderSetupPage({ installationId, existing, error: `Invalid model for ${provider}` }))
  }

  // Validate email
  if (!email || !email.includes('@')) {
    return c.html(renderSetupPage({ installationId, existing, error: 'A valid email address is required' }))
  }

  // Determine API key to use
  const apiKey = apiKeyRaw.trim() || existing?.api_key || ''
  if (!apiKey) {
    return c.html(renderSetupPage({ installationId, existing, error: 'API key is required' }))
  }

  // Only validate format + test key if a new key was submitted
  if (apiKeyRaw.trim()) {
    const formatError = validateKeyFormat(provider, apiKey)
    if (formatError) {
      return c.html(renderSetupPage({ installationId, existing, error: formatError }))
    }

    const testError = await testApiKey(provider, model, apiKey)
    if (testError) {
      return c.html(renderSetupPage({ installationId, existing, error: testError }))
    }
  }

  // Save to Firestore (KMS-encrypts the key inside setInstallation)
  await setInstallation(installationId, {
    api_key:  apiKey,
    provider,
    model,
    email,
    active: true,
  })

  return c.html(renderSetupPage({ installationId, existing: null, success: true }))
}
