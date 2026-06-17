/**
 * Phase 9 storage tests — all Firestore + KMS calls are mocked.
 * Tests cover: installations, jobs, idempotency.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InstallationConfig } from '../../src/types/index.js'

// ─── Mock Firestore ───────────────────────────────────────────────────────────

type DocData = Record<string, unknown>

function makeFirestoreMock(store: Map<string, DocData>) {
  function docRef(collection: string, id: string) {
    const key = `${collection}/${id}`
    return {
      get: async () => {
        const data = store.get(key)
        return { exists: !!data, data: () => data }
      },
      set: async (d: DocData) => { store.set(key, d) },
      delete: async () => { store.delete(key) },
    }
  }

  return {
    collection: (col: string) => ({
      doc: (id: string) => docRef(col, id),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Simple synchronous transaction mock (no real atomicity needed for unit tests)
      const tx = {
        get: async (ref: ReturnType<typeof docRef>) => ref.get(),
        set: (ref: ReturnType<typeof docRef>, data: DocData) => { ref.set(data) },
      }
      return fn(tx)
    },
  }
}

// ─── Mock KMS ─────────────────────────────────────────────────────────────────

const mockEncrypt = vi.fn(async (plain: string) => `enc:${plain}`)
const mockDecrypt = vi.fn(async (cipher: string) => cipher.replace(/^enc:/, ''))

vi.mock('../../src/storage/kms.js', () => ({
  encryptApiKey: (p: string) => mockEncrypt(p),
  decryptApiKey: (c: string) => mockDecrypt(c),
}))

// ─── Setup ────────────────────────────────────────────────────────────────────

let store: Map<string, DocData>

beforeEach(async () => {
  store = new Map()
  const { _setDb } = await import('../../src/storage/firestore.js')
  _setDb(makeFirestoreMock(store) as never)
  vi.clearAllMocks()
})

// ─── Installations ────────────────────────────────────────────────────────────

describe('installations', () => {
  it('returns null for unknown installation', async () => {
    const { getInstallation } = await import('../../src/storage/installations.js')
    expect(await getInstallation(999)).toBeNull()
  })

  it('encrypts API key on write', async () => {
    const { setInstallation } = await import('../../src/storage/installations.js')
    await setInstallation(1, {
      api_key: 'sk-test-key',
      provider: 'openai',
      model: 'gpt-4o-mini',
      email: 'test@example.com',
      active: true,
    })
    expect(mockEncrypt).toHaveBeenCalledWith('sk-test-key')
    // Stored value should be encrypted
    const raw = store.get('installations/1')!
    expect(raw['api_key']).toBe('enc:sk-test-key')
  })

  it('decrypts API key on read', async () => {
    const { setInstallation, getInstallation } = await import('../../src/storage/installations.js')
    await setInstallation(1, {
      api_key: 'sk-real-key',
      provider: 'openai',
      model: 'gpt-4o-mini',
      email: 'test@example.com',
      active: true,
    })
    const config = await getInstallation(1)
    expect(config).not.toBeNull()
    expect(config!.api_key).toBe('sk-real-key')
    expect(mockDecrypt).toHaveBeenCalledWith('enc:sk-real-key')
  })

  it('round-trips full InstallationConfig', async () => {
    const { setInstallation, getInstallation } = await import('../../src/storage/installations.js')
    await setInstallation(42, {
      api_key: 'sk-ant-abc123',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      email: 'dev@company.com',
      active: true,
    })
    const config = await getInstallation(42)
    expect(config!.provider).toBe('anthropic')
    expect(config!.model).toBe('claude-sonnet-4-6')
    expect(config!.email).toBe('dev@company.com')
    expect(config!.active).toBe(true)
    expect(config!.created_at).toBeDefined()
    expect(config!.updated_at).toBeDefined()
  })

  it('preserves created_at on update', async () => {
    const { setInstallation, getInstallation } = await import('../../src/storage/installations.js')
    await setInstallation(5, {
      api_key: 'sk-key-1',
      provider: 'openai',
      model: 'gpt-4o',
      email: 'a@b.com',
      active: true,
    })
    const first = await getInstallation(5)
    const createdAt = first!.created_at

    // Update the key
    await setInstallation(5, {
      api_key: 'sk-key-2',
      provider: 'openai',
      model: 'gpt-4o-mini',
      email: 'a@b.com',
      active: true,
    })
    const second = await getInstallation(5)
    expect(second!.created_at).toBe(createdAt)
    expect(second!.model).toBe('gpt-4o-mini')
  })

  it('deleteInstallation removes the doc', async () => {
    const { setInstallation, getInstallation, deleteInstallation } = await import('../../src/storage/installations.js')
    await setInstallation(7, {
      api_key: 'sk-x',
      provider: 'openai',
      model: 'gpt-4o',
      email: 'x@x.com',
      active: true,
    })
    expect(await getInstallation(7)).not.toBeNull()
    await deleteInstallation(7)
    expect(await getInstallation(7)).toBeNull()
  })
})

// ─── Jobs (findings + traces) ─────────────────────────────────────────────────

describe('jobs', () => {
  it('returns null for unknown job key', async () => {
    const { getFindings } = await import('../../src/storage/jobs.js')
    expect(await getFindings('repo:123:abc')).toBeNull()
  })

  it('saves and retrieves findings', async () => {
    const { saveFindings, getFindings } = await import('../../src/storage/jobs.js')
    const results = [
      {
        agent: 'SecurityAgent',
        findings: [{ severity: 'HOLD' as const, message: 'Secret found', file: 'src/config.js', line: 5 }],
        trace: { agent: 'SecurityAgent', started_at: new Date().toISOString(), duration_ms: 100, finding_count: 1, timed_out: false },
      },
    ]
    await saveFindings('owner/repo:1:abc123', results)
    const retrieved = await getFindings('owner/repo:1:abc123')
    expect(retrieved).not.toBeNull()
    expect(retrieved![0]!.agent).toBe('SecurityAgent')
    expect(retrieved![0]!.findings[0]!.severity).toBe('HOLD')
  })

  it('saves and retrieves trace', async () => {
    const { saveTrace, getTrace } = await import('../../src/storage/jobs.js')
    const trace = {
      job_id: 'test-job-1',
      command: 'review:security' as const,
      started_at: new Date().toISOString(),
      duration_ms: 1500,
      agents: [],
      total_findings: 3,
      llm_tokens_used: 0,
    }
    await saveTrace('test-job-1', trace)
    const retrieved = await getTrace('test-job-1')
    expect(retrieved!.job_id).toBe('test-job-1')
    expect(retrieved!.total_findings).toBe(3)
    expect(retrieved!.command).toBe('review:security')
  })

  it('returns null for unknown trace', async () => {
    const { getTrace } = await import('../../src/storage/jobs.js')
    expect(await getTrace('nonexistent-job')).toBeNull()
  })
})

// ─── Firestore-backed idempotency ─────────────────────────────────────────────

describe('storage idempotency', () => {
  it('first delivery claim returns true', async () => {
    const { checkAndClaimDelivery } = await import('../../src/storage/idempotency.js')
    expect(await checkAndClaimDelivery('delivery-abc')).toBe(true)
  })

  it('duplicate delivery claim returns false', async () => {
    const { checkAndClaimDelivery } = await import('../../src/storage/idempotency.js')
    await checkAndClaimDelivery('delivery-xyz')
    expect(await checkAndClaimDelivery('delivery-xyz')).toBe(false)
  })

  it('different delivery IDs are independent', async () => {
    const { checkAndClaimDelivery } = await import('../../src/storage/idempotency.js')
    expect(await checkAndClaimDelivery('del-1')).toBe(true)
    expect(await checkAndClaimDelivery('del-2')).toBe(true)
  })

  it('first job claim returns true', async () => {
    const { checkAndClaimJob, jobKey } = await import('../../src/storage/idempotency.js')
    const key = jobKey('owner/repo', 1, 'sha123')
    expect(await checkAndClaimJob(key)).toBe(true)
  })

  it('duplicate job claim returns false', async () => {
    const { checkAndClaimJob, jobKey } = await import('../../src/storage/idempotency.js')
    const key = jobKey('owner/repo', 1, 'sha123')
    await checkAndClaimJob(key)
    expect(await checkAndClaimJob(key)).toBe(false)
  })

  it('releaseJob allows re-claim', async () => {
    const { checkAndClaimJob, releaseJob, jobKey } = await import('../../src/storage/idempotency.js')
    const key = jobKey('owner/repo', 2, 'sha456')
    await checkAndClaimJob(key)
    await releaseJob(key)
    expect(await checkAndClaimJob(key)).toBe(true)
  })

  it('jobKey formats correctly', async () => {
    const { jobKey } = await import('../../src/storage/idempotency.js')
    expect(jobKey('owner/repo', 42, 'abc123')).toBe('owner/repo:42:abc123')
  })
})
