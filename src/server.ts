import { Hono } from 'hono'
import { config } from 'dotenv'
import { handleWebhook, setWebhookSecret } from './webhook/handler.js'
import { handleSetupGet, handleSetupPost } from './setup/handler.js'

config()

const app = new Hono()

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/', (c) => c.json({ ok: true, service: 'pr-scrutiny', version: '0.1.0' }))
app.get('/health', (c) => c.json({ ok: true }))

// ─── Setup page (GitHub App post-install redirect) ────────────────────────────
// GitHub redirects here after app install: /setup?installation_id=123

app.get('/setup', handleSetupGet)
app.post('/setup', handleSetupPost)

// ─── Webhook endpoint ─────────────────────────────────────────────────────────

app.post('/webhook', handleWebhook)

// ─── Startup ─────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3000)
const secret = process.env.GITHUB_WEBHOOK_SECRET ?? ''

if (secret) {
  setWebhookSecret(secret)
  console.log('Webhook HMAC validation enabled')
} else {
  console.warn('GITHUB_WEBHOOK_SECRET not set — HMAC validation disabled (dev mode)')
}

export default {
  port,
  fetch: app.fetch,
}

console.log(`PR Scrutiny server listening on port ${port}`)
