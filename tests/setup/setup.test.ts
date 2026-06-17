/**
 * Phase 9 setup page + handler tests.
 * Mocks: Firestore, KMS, LLM (key test call).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock storage layer
const mockGetInstallation = vi.fn()
const mockSetInstallation = vi.fn()

vi.mock('../../src/storage/installations.js', () => ({
  getInstallation: (...args: unknown[]) => mockGetInstallation(...args),
  setInstallation: (...args: unknown[]) => mockSetInstallation(...args),
}))

// Mock LLM test call (generateText in setup handler)
const mockGenerateText = vi.fn()
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: (...args: unknown[]) => mockGenerateText(...args) }
})

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => () => 'mock-openai-model',
}))
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => () => 'mock-anthropic-model',
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => () => 'mock-google-model',
}))

// ─── App setup ────────────────────────────────────────────────────────────────

async function makeApp() {
  const { handleSetupGet, handleSetupPost } = await import('../../src/setup/handler.js')
  const app = new Hono()
  app.get('/setup', handleSetupGet)
  app.post('/setup', handleSetupPost)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetInstallation.mockResolvedValue(null)
  mockSetInstallation.mockResolvedValue(undefined)
  mockGenerateText.mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } })
})

// ─── GET /setup ───────────────────────────────────────────────────────────────

describe('GET /setup', () => {
  it('returns 400 when installation_id missing', async () => {
    const app = await makeApp()
    const res = await app.request('/setup')
    expect(res.status).toBe(400)
  })

  it('renders HTML form for new installation', async () => {
    const app = await makeApp()
    const res = await app.request('/setup?installation_id=123')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('PR Scrutiny')
    expect(html).toContain('Installation #123')
    expect(html).toContain('<form')
    expect(html).toContain('name="provider"')
    expect(html).toContain('name="api_key"')
    expect(html).toContain('name="email"')
  })

  it('pre-fills existing provider + model + email', async () => {
    mockGetInstallation.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      email: 'dev@corp.com',
      api_key: 'sk-ant-real-key-12345678',
      active: true,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    const app = await makeApp()
    const res = await app.request('/setup?installation_id=55')
    const html = await res.text()
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('dev@corp.com')
    // API key should be masked, not shown in full
    expect(html).not.toContain('sk-ant-real-key-12345678')
    expect(html).toContain('sk-ant-')  // shows prefix in masked key
  })

  it('shows model dropdown options for all providers', async () => {
    const app = await makeApp()
    const res = await app.request('/setup?installation_id=1')
    const html = await res.text()
    // Provider options
    expect(html).toContain('openai')
    expect(html).toContain('anthropic')
    expect(html).toContain('google')
    // Model data for JS
    expect(html).toContain('gpt-4o-mini')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('gemini-2.5-flash')
  })
})

// ─── POST /setup ──────────────────────────────────────────────────────────────

describe('POST /setup', () => {
  function makeFormBody(fields: Record<string, string>): string {
    return Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
  }

  async function postSetup(app: Hono, fields: Record<string, string>) {
    return app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: makeFormBody(fields),
    })
  }

  it('returns 400 when installation_id missing', async () => {
    const app = await makeApp()
    const res = await postSetup(app, { provider: 'openai', model: 'gpt-4o', api_key: 'sk-abc', email: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  it('rejects invalid provider', async () => {
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '1', provider: 'fake-llm', model: 'gpt-4o', api_key: 'sk-abc', email: 'a@b.com',
    })
    const html = await res.text()
    expect(html).toContain('Invalid provider')
  })

  it('rejects invalid model for provider', async () => {
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '1', provider: 'openai', model: 'claude-opus-4-6', api_key: 'sk-abc', email: 'a@b.com',
    })
    const html = await res.text()
    expect(html).toContain('Invalid model')
  })

  it('rejects missing email', async () => {
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '1', provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-abc', email: '',
    })
    const html = await res.text()
    expect(html).toContain('email')
  })

  it('rejects OpenAI key with wrong prefix', async () => {
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '1', provider: 'openai', model: 'gpt-4o-mini',
      api_key: 'sk-ant-anthropic-key-here', email: 'a@b.com',
    })
    const html = await res.text()
    expect(html).toContain('sk-')
  })

  it('rejects Anthropic key with wrong prefix', async () => {
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '1', provider: 'anthropic', model: 'claude-sonnet-4-6',
      api_key: 'sk-openai-key-here-not-ant', email: 'a@b.com',
    })
    const html = await res.text()
    expect(html).toContain('sk-ant-')
  })

  it('rejects key that fails live test (401)', async () => {
    mockGenerateText.mockRejectedValue(new Error('401 Unauthorized: invalid API key'))
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '1', provider: 'openai', model: 'gpt-4o-mini',
      api_key: 'sk-bad-key-xxxxxxxxxxxxxxxxxx', email: 'a@b.com',
    })
    const html = await res.text()
    expect(html).toContain('invalid')
    expect(mockSetInstallation).not.toHaveBeenCalled()
  })

  it('saves config and shows success on valid key', async () => {
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '10', provider: 'openai', model: 'gpt-4o-mini',
      api_key: 'sk-valid-key-xxxxxxxxxxxxxxxxxxx', email: 'user@company.com',
    })
    const html = await res.text()
    expect(html).toContain("You're all set")
    expect(mockSetInstallation).toHaveBeenCalledWith(10, expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4o-mini',
      email: 'user@company.com',
      active: true,
    }))
  })

  it('uses existing key when api_key field is blank (update without key change)', async () => {
    mockGetInstallation.mockResolvedValue({
      provider: 'openai', model: 'gpt-4o', email: 'old@co.com',
      api_key: 'sk-existing-key-xxxxxxxxxxxxxxxx', active: true,
      created_at: '2026-01-01', updated_at: '2026-01-01',
    })
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '20', provider: 'openai', model: 'gpt-4o-mini',
      api_key: '', email: 'new@co.com',  // blank key = keep existing
    })
    const html = await res.text()
    expect(html).toContain("You're all set")
    // Should save with the existing key (no test call since no new key)
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(mockSetInstallation).toHaveBeenCalledWith(20, expect.objectContaining({
      api_key: 'sk-existing-key-xxxxxxxxxxxxxxxx',
      email: 'new@co.com',
    }))
  })

  it('non-auth LLM error (e.g. 503) does not block save', async () => {
    // Infrastructure errors should not prevent saving a valid-looking key
    mockGenerateText.mockRejectedValue(new Error('503 Service Unavailable'))
    const app = await makeApp()
    const res = await postSetup(app, {
      installation_id: '30', provider: 'openai', model: 'gpt-4o-mini',
      api_key: 'sk-valid-looking-key-xxxxxxxxxxxx', email: 'a@b.com',
    })
    const html = await res.text()
    expect(html).toContain("You're all set")
    expect(mockSetInstallation).toHaveBeenCalled()
  })
})
