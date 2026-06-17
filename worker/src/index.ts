export interface Env {
  KV: KVNamespace
  GITHUB_APP_ID: string
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_WEBHOOK_SECRET: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/webhook') {
      // TODO: webhook handler
      return new Response('ok', { status: 200 })
    }

    if (request.method === 'GET' && url.pathname === '/setup') {
      // TODO: post-install onboarding
      return new Response('setup', { status: 200 })
    }

    return new Response('not found', { status: 404 })
  },
}
