import { describe, it, expect, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { verifySignature } from '../../src/webhook/hmac.js'
import { parseSlashCommand, parseWebhookContext } from '../../src/webhook/parser.js'
import { handleWebhook, setWebhookSecret } from '../../src/webhook/handler.js'
import { _reset } from '../../src/webhook/idempotency.js'

// ─── HMAC ────────────────────────────────────────────────────────────────────

describe('HMAC verification', () => {
  const secret = 'test-secret'

  function sign(body: string) {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  }

  it('accepts valid signature', () => {
    const body = '{"action":"opened"}'
    expect(verifySignature(body, sign(body), secret)).toBe(true)
  })

  it('rejects wrong signature', () => {
    const body = '{"action":"opened"}'
    expect(verifySignature(body, 'sha256=deadbeef', secret)).toBe(false)
  })

  it('rejects missing signature', () => {
    expect(verifySignature('body', undefined, secret)).toBe(false)
    expect(verifySignature('body', null, secret)).toBe(false)
  })

  it('rejects tampered body', () => {
    const original = '{"action":"opened"}'
    const tampered = '{"action":"closed"}'
    expect(verifySignature(tampered, sign(original), secret)).toBe(false)
  })
})

// ─── Slash command parser ────────────────────────────────────────────────────

describe('parseSlashCommand', () => {
  it('parses /review', () => {
    expect(parseSlashCommand('/review')).toEqual({ command: 'review' })
  })

  it('parses /review:security', () => {
    expect(parseSlashCommand('/review:security')).toEqual({ command: 'review:security' })
  })

  it('parses /ask with question', () => {
    expect(parseSlashCommand('/ask What does db.js export?')).toEqual({
      command: 'ask',
      question: 'What does db.js export?',
    })
  })

  it('parses /ask without question — question is undefined', () => {
    const result = parseSlashCommand('/ask')
    expect(result?.command).toBe('ask')
    expect(result?.question).toBeUndefined()
  })

  it('parses /summarize', () => {
    expect(parseSlashCommand('/summarize')).toEqual({ command: 'summarize' })
  })

  it('parses /blast-radius', () => {
    expect(parseSlashCommand('/blast-radius')).toEqual({ command: 'blast-radius' })
  })

  it('returns null for unknown command', () => {
    expect(parseSlashCommand('/foo')).toBeNull()
  })

  it('returns null for non-slash comment', () => {
    expect(parseSlashCommand('Great PR!')).toBeNull()
    expect(parseSlashCommand('LGTM')).toBeNull()
  })

  it('ignores trailing newlines / extra whitespace', () => {
    expect(parseSlashCommand('  /review  \n\nsome comment')).toEqual({ command: 'review' })
  })
})

// ─── Webhook context parser ──────────────────────────────────────────────────

describe('parseWebhookContext', () => {
  const delivery = 'abc-123'

  it('parses issue_comment event (slash command on PR)', () => {
    const body = {
      action: 'created',
      installation: { id: 42 },
      repository: { full_name: 'acme/backend' },
      issue: { number: 7, pull_request: { url: 'https://...' } },
      comment: { body: '/review', user: { login: 'alice' } },
    }
    const ctx = parseWebhookContext('issue_comment', delivery, body)
    expect(ctx.eventType).toBe('issue_comment')
    expect(ctx.action).toBe('created')
    expect(ctx.prNumber).toBe(7)
    expect(ctx.commentBody).toBe('/review')
    expect(ctx.commenterLogin).toBe('alice')
    expect(ctx.repo).toBe('acme/backend')
    expect(ctx.installationId).toBe(42)
  })

  it('issue_comment on plain issue (not PR) → prNumber null', () => {
    const body = {
      action: 'created',
      installation: { id: 1 },
      repository: { full_name: 'acme/backend' },
      issue: { number: 99 },  // no pull_request key
      comment: { body: '/review', user: { login: 'bob' } },
    }
    const ctx = parseWebhookContext('issue_comment', delivery, body)
    expect(ctx.prNumber).toBeNull()
  })

  it('parses pull_request opened event', () => {
    const body = {
      action: 'opened',
      installation: { id: 5 },
      repository: { full_name: 'acme/backend' },
      pull_request: { number: 3, head: { sha: 'abc123' }, base: { ref: 'main' } },
    }
    const ctx = parseWebhookContext('pull_request', delivery, body)
    expect(ctx.eventType).toBe('pull_request')
    expect(ctx.prNumber).toBe(3)
    expect(ctx.headSha).toBe('abc123')
    expect(ctx.baseBranch).toBe('main')
  })

  it('returns unknown for unrecognized event', () => {
    const ctx = parseWebhookContext('push', delivery, {})
    expect(ctx.eventType).toBe('unknown')
  })

  it('ping event parses correctly', () => {
    const ctx = parseWebhookContext('ping', delivery, { installation: { id: 1 }, repository: { full_name: 'a/b' } })
    expect(ctx.eventType).toBe('ping')
  })
})

// ─── Webhook handler (end-to-end via Hono test client) ──────────────────────

function makeApp() {
  const app = new Hono()
  app.post('/webhook', handleWebhook)
  return app
}

function makeRequest(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body)
  return app.request('/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  })
}

const secret = 'webhook-test-secret'

function sign(body: string) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('Webhook handler', () => {
  beforeEach(() => {
    _reset()
    setWebhookSecret('')  // no HMAC by default; individual tests opt in
  })

  it('GET /webhook → 404 (only POST accepted)', async () => {
    const app = makeApp()
    const res = await app.request('/webhook', { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('ping event → 200 pong', async () => {
    const app = makeApp()
    const res = await makeRequest(app, { zen: 'hello' }, { 'x-github-event': 'ping', 'x-github-delivery': 'd-1' })
    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; message: string }
    expect(json.ok).toBe(true)
    expect(json.message).toBe('pong')
  })

  it('invalid HMAC → 401', async () => {
    setWebhookSecret(secret)
    const app = makeApp()
    const res = await makeRequest(app, { action: 'opened' }, {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'd-2',
      'x-hub-signature-256': 'sha256=badhash',
    })
    expect(res.status).toBe(401)
  })

  it('valid HMAC → accepted', async () => {
    setWebhookSecret(secret)
    const app = makeApp()
    const body = { action: 'ping' }
    const raw = JSON.stringify(body)
    const res = await makeRequest(app, body, {
      'x-github-event': 'ping',
      'x-github-delivery': 'd-3',
      'x-hub-signature-256': sign(raw),
    })
    expect(res.status).toBe(200)
  })

  it('duplicate delivery ID → skipped', async () => {
    const app = makeApp()
    // Use a real event that goes through dedup (not ping — ping returns before dedup)
    const body = { action: 'deleted' }
    const headers = { 'x-github-event': 'push', 'x-github-delivery': 'd-4' }
    await makeRequest(app, body, headers)
    const res2 = await makeRequest(app, body, headers)
    const json = await res2.json() as { skipped: string }
    expect(json.skipped).toBe('duplicate_delivery')
  })

  it('unhandled event type → skipped', async () => {
    const app = makeApp()
    const res = await makeRequest(app, { action: 'deleted' }, {
      'x-github-event': 'push',
      'x-github-delivery': 'd-5',
    })
    const json = await res.json() as { skipped: string }
    expect(json.skipped).toBe('unhandled_event')
  })

  it('issue_comment with non-slash body → skipped', async () => {
    const app = makeApp()
    const res = await makeRequest(app, {
      action: 'created',
      installation: { id: 1 },
      repository: { full_name: 'a/b' },
      issue: { number: 1, pull_request: {} },
      comment: { body: 'LGTM!', user: { login: 'alice' } },
    }, { 'x-github-event': 'issue_comment', 'x-github-delivery': 'd-6' })
    const json = await res.json() as { skipped: string }
    expect(json.skipped).toBe('not_a_slash_command')
  })

  it('valid /review command → queued', async () => {
    const app = makeApp()
    const res = await makeRequest(app, {
      action: 'created',
      installation: { id: 7 },
      repository: { full_name: 'acme/backend' },
      issue: { number: 42, pull_request: { url: 'https://...' } },
      comment: { body: '/review', user: { login: 'alice' } },
    }, { 'x-github-event': 'issue_comment', 'x-github-delivery': 'd-7' })
    expect(res.status).toBe(200)
    const json = await res.json() as { queued: boolean; command: string }
    expect(json.queued).toBe(true)
    expect(json.command).toBe('review')
  })

  it('pull_request opened → queued as review', async () => {
    const app = makeApp()
    const res = await makeRequest(app, {
      action: 'opened',
      installation: { id: 1 },
      repository: { full_name: 'acme/backend' },
      pull_request: { number: 5, head: { sha: 'deadbeef' }, base: { ref: 'main' } },
    }, { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-8' })
    const json = await res.json() as { queued: boolean; command: string }
    expect(json.queued).toBe(true)
    expect(json.command).toBe('review')
  })

  it('duplicate job (same repo+pr+sha) → skipped', async () => {
    const app = makeApp()
    const payload = {
      action: 'opened',
      installation: { id: 1 },
      repository: { full_name: 'acme/backend' },
      pull_request: { number: 5, head: { sha: 'abc123' }, base: { ref: 'main' } },
    }
    await makeRequest(app, payload, { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-9' })
    const res2 = await makeRequest(app, payload, { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-10' })
    const json = await res2.json() as { skipped: string }
    expect(json.skipped).toBe('job_already_running')
  })

  it('malformed JSON body → 400', async () => {
    const app = makeApp()
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': 'd-11' },
      body: 'not json {{{',
    })
    expect(res.status).toBe(400)
  })
})
