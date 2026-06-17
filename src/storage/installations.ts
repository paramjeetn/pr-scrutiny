import type { InstallationConfig } from '../types/index.js'
import { getDb } from './firestore.js'
import { encryptApiKey, decryptApiKey } from './kms.js'

const COLLECTION = 'installations'

export async function getInstallation(installationId: number): Promise<InstallationConfig | null> {
  const doc = await getDb().collection(COLLECTION).doc(String(installationId)).get()
  if (!doc.exists) return null

  const data = doc.data() as InstallationConfig & { api_key: string }

  // Decrypt the API key before returning
  const plainKey = await decryptApiKey(data.api_key)
  return { ...data, api_key: plainKey }
}

export async function setInstallation(
  installationId: number,
  config: Omit<InstallationConfig, 'api_key' | 'created_at' | 'updated_at'> & { api_key: string }
): Promise<void> {
  const encryptedKey = await encryptApiKey(config.api_key)
  const now = new Date().toISOString()

  const ref = getDb().collection(COLLECTION).doc(String(installationId))
  const existing = await ref.get()

  await ref.set({
    ...config,
    api_key: encryptedKey,
    updated_at: now,
    created_at: existing.exists ? existing.data()!['created_at'] : now,
  })
}

export async function deleteInstallation(installationId: number): Promise<void> {
  await getDb().collection(COLLECTION).doc(String(installationId)).delete()
}
