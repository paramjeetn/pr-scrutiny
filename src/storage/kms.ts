import { KeyManagementServiceClient } from '@google-cloud/kms'

let _client: KeyManagementServiceClient | null = null

function getClient(): KeyManagementServiceClient {
  if (!_client) _client = new KeyManagementServiceClient()
  return _client
}

function keyName(): string {
  const project  = process.env['GCP_PROJECT_ID']!
  const keyring  = process.env['KMS_KEYRING'] ?? 'pr-scrutiny'
  const key      = process.env['KMS_KEY']     ?? 'installation-keys'
  return `projects/${project}/locations/global/keyRings/${keyring}/cryptoKeys/${key}`
}

export async function encryptApiKey(plaintext: string): Promise<string> {
  const [result] = await getClient().encrypt({
    name: keyName(),
    plaintext: Buffer.from(plaintext),
  })
  return Buffer.from(result.ciphertext as Uint8Array).toString('base64')
}

export async function decryptApiKey(ciphertext: string): Promise<string> {
  const [result] = await getClient().decrypt({
    name: keyName(),
    ciphertext: Buffer.from(ciphertext, 'base64'),
  })
  return Buffer.from(result.plaintext as Uint8Array).toString('utf8')
}

// For tests — override with mock implementations
export function _setClient(c: KeyManagementServiceClient) { _client = c }
export function _resetClient() { _client = null }
