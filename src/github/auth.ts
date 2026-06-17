import { createSign } from 'node:crypto'
import { request } from '@octokit/request'

/**
 * Generate a GitHub App JWT (valid 10 minutes).
 * Used to exchange for an Installation Access Token.
 */
export function createAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,   // 60s back-date for clock skew
    exp: now + 600,  // 10 minutes
    iss: appId,
  })).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(privateKey, 'base64url')

  return `${header}.${payload}.${signature}`
}

/**
 * Exchange App JWT for an Installation Access Token (scoped to one installation).
 * Token expires in 1 hour.
 */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number
): Promise<string> {
  const jwt = createAppJWT(appId, privateKey)

  const response = await request('POST /app/installations/{installation_id}/access_tokens', {
    installation_id: installationId,
    headers: {
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': '2022-11-28',
    },
  })

  return response.data.token as string
}
